"""Deployment files: the compose checker, the loader generator, and the committed deploy files.

`deploy/tools/*.py` are standalone scripts (run with `python -I`), so they are loaded here by
path rather than imported as a package. The loader scripts and the entrypoint are also run for
real under `sh` with stub `psql`/`pg_isready` (skipped when there is no `sh`), because the image
and the server steps cannot be exercised locally: no Docker and no Postgres.
"""

import base64
import gzip
import importlib.util
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from urllib.parse import unquote, urlsplit

import pytest

REPO = Path(__file__).resolve().parents[2]
COMPOSE_DIR = REPO / "deploy" / "compose"


def _load_tool(name: str) -> ModuleType:
    path = REPO / "deploy" / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check_compose = _load_tool("check_compose")
build_loaders = _load_tool("build_loaders")

GOOD = "name: x\nservices:\n  a:\n    image: busybox:1.37\n"


def _write(tmp_path: Path, text: str, name: str = "x.yml") -> Path:
    path = tmp_path / name
    path.write_bytes(text.encode("utf-8"))
    return path


def test_committed_compose_files_pass_the_checker() -> None:
    assert check_compose.main([str(COMPOSE_DIR)]) == 0


def test_checker_accepts_a_clean_file(tmp_path: Path) -> None:
    _write(tmp_path, GOOD)
    assert check_compose.main([str(tmp_path)]) == 0


def test_checker_rejects_the_latest_tag(tmp_path: Path) -> None:
    _write(tmp_path, GOOD.replace("busybox:1.37", "x:latest"))
    assert check_compose.main([str(tmp_path)]) == 1


@pytest.mark.parametrize("image", ["busybox", "ghcr.io/o/r", "localhost:5000/r", "x:LATEST"])
def test_checker_rejects_an_image_without_a_usable_tag(tmp_path: Path, image: str) -> None:
    _write(tmp_path, GOOD.replace("busybox:1.37", image))
    assert check_compose.main([str(tmp_path)]) == 1


@pytest.mark.parametrize(
    "image",
    ["busybox:1.37", "postgres:16-alpine", "localhost:5000/r:2", "x@sha256:" + "0" * 64],
)
def test_checker_accepts_pinned_images(tmp_path: Path, image: str) -> None:
    _write(tmp_path, GOOD.replace("busybox:1.37", image))
    assert check_compose.main([str(tmp_path)]) == 0


def test_checker_rejects_an_interpolated_tag(tmp_path: Path) -> None:
    _write(tmp_path, GOOD.replace("busybox:1.37", "x:${TAG}"))
    assert check_compose.main([str(tmp_path)]) == 1


def test_checker_ignores_a_commented_image_line(tmp_path: Path) -> None:
    _write(tmp_path, GOOD + "    # image: x:latest\n")
    assert check_compose.main([str(tmp_path)]) == 0


def test_checker_rejects_oversize_files(tmp_path: Path) -> None:
    limit = check_compose.MAX_CHARS
    assert limit == 8192
    _write(tmp_path, GOOD + "#" * (limit - len(GOOD)) + "\n", "exact.yml")
    assert check_compose.main([str(tmp_path / "exact.yml")]) == 1  # one char over
    _write(tmp_path, GOOD + "#" * (limit - len(GOOD) - 1) + "\n", "fits.yml")
    assert check_compose.main([str(tmp_path / "fits.yml")]) == 0


def test_checker_rejects_carriage_returns(tmp_path: Path) -> None:
    _write(tmp_path, GOOD.replace("\n", "\r\n"))
    assert check_compose.main([str(tmp_path)]) == 1


# Built from parts so that no address literal sits in this file.
FAKE_IP = ".".join(("203", "0", "113", "7"))  # noqa: FLY002


@pytest.mark.parametrize(
    "leak", [f"host: {FAKE_IP}", f"url: http://{FAKE_IP}:8000", "k: sk-abc123"]
)
def test_checker_rejects_ips_and_api_key_prefixes(tmp_path: Path, leak: str) -> None:
    _write(tmp_path, GOOD + f"# {leak}\n")
    assert check_compose.main([str(tmp_path)]) == 1


@pytest.mark.parametrize("fine", ["tag 1.2.3", "task-12 risk-free disk-usage", "version 0.1.0"])
def test_checker_does_not_flag_look_alikes(tmp_path: Path, fine: str) -> None:
    _write(tmp_path, GOOD + f"# {fine}\n")
    assert check_compose.main([str(tmp_path)]) == 0


def test_checker_fails_when_there_is_nothing_to_check(tmp_path: Path) -> None:
    assert check_compose.main([str(tmp_path)]) == 1
    assert check_compose.main([str(tmp_path / "missing.yml")]) == 1
    assert check_compose.main([]) == 1


def test_checker_reports_every_problem_not_just_the_first(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(tmp_path, GOOD.replace("busybox:1.37", "x:latest") + f"# {FAKE_IP}\n", "bad.yml")
    assert check_compose.main([str(tmp_path)]) == 1
    out = capsys.readouterr().out
    assert "bad.yml" in out
    assert "latest" in out
    assert FAKE_IP not in out  # the offending text itself is never echoed back


# --- the committed compose files ---------------------------------------------------------------

API_COMPOSE = COMPOSE_DIR / "yawmi-api.api.yml"
LOADER_1 = COMPOSE_DIR / "yawmi-db-1-schema.yml"
LOADER_2 = COMPOSE_DIR / "yawmi-db-2-role.yml"
KEYGEN = COMPOSE_DIR / "yawmi-vapid-keygen.yml"
ALL_COMPOSE = [API_COMPOSE, LOADER_1, LOADER_2, KEYGEN]


# D-7: left empty, these two would give an empty Host() rule and the default certificate.
API_HOST = "${YAWMI_API_HOST:?YAWMI_API_HOST is required}"
CERT_RESOLVER = "${TRAEFIK_CERT_RESOLVER:?TRAEFIK_CERT_RESOLVER is required}"


def _yaml(path: Path) -> dict:
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _labels(service: dict) -> dict[str, str]:
    return dict(item.split("=", 1) for item in service["labels"])


@pytest.mark.parametrize("path", ALL_COMPOSE, ids=lambda p: p.name)
def test_compose_files_are_lf_utf8_and_within_the_manager_limit(path: Path) -> None:
    raw = path.read_bytes()
    assert b"\r" not in raw
    assert len(raw.decode("utf-8")) <= 8192


@pytest.mark.parametrize("path", ALL_COMPOSE, ids=lambda p: p.name)
def test_compose_files_publish_no_port_and_carry_no_secret_values(path: Path) -> None:
    data = _yaml(path)
    for service in data["services"].values():
        assert "ports" not in service
        assert "env_file" not in service
    text = path.read_text(encoding="utf-8")
    for forbidden in ("YAWMI_DATABASE_URL", "BEGIN PRIVATE", "postgresql://"):
        assert forbidden not in text
    # a password may only be assigned from a command substitution, never from a literal
    assert not re.search(r'PASSWORD=(?!"\$\$\()', text)


def test_api_compose_project_service_and_pinned_image() -> None:
    data = _yaml(API_COMPOSE)
    assert data["name"] == "yawmi-api"
    service = data["services"]["yawmi-api"]
    assert re.fullmatch(r"ghcr\.io/nexgen94/yawmi-api:\d+\.\d+\.\d+", service["image"])
    assert service["restart"] == "unless-stopped"


def test_api_compose_networks_come_from_variables_and_are_external() -> None:
    data = _yaml(API_COMPOSE)
    assert set(data["services"]["yawmi-api"]["networks"]) == {"n8n", "raqib"}
    n8n, raqib = data["networks"]["n8n"], data["networks"]["raqib"]
    assert n8n["external"] is True and raqib["external"] is True
    assert n8n["name"].startswith("${N8N_NETWORK")
    assert raqib["name"] == "${RAQIB_NETWORK:-raqib_internal}"


def test_api_compose_mounts_the_secrets_volume_read_only() -> None:
    data = _yaml(API_COMPOSE)
    assert data["services"]["yawmi-api"]["volumes"] == ["yawmi_secrets:/run/yawmi:ro"]
    assert data["volumes"]["yawmi_secrets"] == {"name": "yawmi_secrets", "external": True}


def test_api_compose_never_passes_the_database_password_or_url() -> None:
    env = _yaml(API_COMPOSE)["services"]["yawmi-api"]["environment"]
    assert "YAWMI_DATABASE_URL" not in env
    assert not any("PASSWORD" in key and "FILE" not in key for key in env)
    for name in ("YAWMI_JWT_SECRET", "YAWMI_ANTHROPIC_API_KEY", "YAWMI_DB_HOST"):
        assert re.fullmatch(r"\$\{" + name + r":\?[^}]+\}", env[name])  # required, typed by hand
    assert env["YAWMI_LOG_BODIES"] == "false"
    assert env["YAWMI_SEND_RAW_HEALTH"] == "false"


def test_api_compose_passes_push_settings_off_by_default_and_never_a_key() -> None:
    env = _yaml(API_COMPOSE)["services"]["yawmi-api"]["environment"]
    assert env["YAWMI_PUSH_ENABLED"] == "${YAWMI_PUSH_ENABLED:-false}"
    assert env["YAWMI_VAPID_SUBJECT"] == "${YAWMI_VAPID_SUBJECT:-}"
    assert env["YAWMI_VAPID_PRIVATE_KEY_FILE"] == "/run/yawmi/vapid_private.pem"
    assert env["YAWMI_PUSH_HOSTS"] == "${YAWMI_PUSH_HOSTS:-}"  # empty: the default list


def test_vapid_keygen_is_one_shot_offline_hardened_and_writes_only_the_secrets_volume() -> None:
    data = _yaml(KEYGEN)
    assert data["name"] == "yawmi-vapid-keygen"
    service = data["services"]["yawmi-vapid-keygen"]
    api_image = _yaml(API_COMPOSE)["services"]["yawmi-api"]["image"]
    assert service["image"].rsplit(":", 1)[0] == api_image.rsplit(":", 1)[0]
    assert service["restart"] == "no"
    assert service["network_mode"] == "none" and "networks" not in service
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"] and service["cap_add"] == ["CHOWN"]
    assert "no-new-privileges:true" in service["security_opt"]
    assert service["volumes"] == ["yawmi_secrets:/run/yawmi"]
    assert data["volumes"]["yawmi_secrets"] == {"name": "yawmi_secrets", "external": True}
    # no path on the command line: the key file comes from the same variable the API reads
    assert service["entrypoint"] == ["python", "-I", "-m", "yawmi.push.keygen", "--group", "10001"]
    api_env = _yaml(API_COMPOSE)["services"]["yawmi-api"]["environment"]
    assert service["environment"] == {
        "YAWMI_VAPID_PRIVATE_KEY_FILE": api_env["YAWMI_VAPID_PRIVATE_KEY_FILE"]
    }


def test_api_compose_is_hardened() -> None:
    service = _yaml(API_COMPOSE)["services"]["yawmi-api"]
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in service["security_opt"]


def test_api_compose_traefik_router_priority_tls_and_rate_limit() -> None:
    labels = _labels(_yaml(API_COMPOSE)["services"]["yawmi-api"])
    assert labels["traefik.enable"] == "true"
    assert labels["traefik.http.routers.yawmi-api.rule"] == (
        f"Host(`{API_HOST}`) && PathPrefix(`/v1`)"
    )
    assert labels["traefik.http.routers.yawmi-api.priority"] == "100"
    assert labels["traefik.http.routers.yawmi-api.tls"] == "true"
    assert labels["traefik.http.routers.yawmi-api.tls.certresolver"] == CERT_RESOLVER
    assert labels["traefik.http.services.yawmi-api.loadbalancer.server.port"] == "8000"
    assert labels["traefik.http.routers.yawmi-api.middlewares"] == "yawmi-rl"
    rl = "traefik.http.middlewares.yawmi-rl.ratelimit."
    assert (labels[rl + "average"], labels[rl + "period"], labels[rl + "burst"]) == (
        "60",
        "1m",
        "20",
    )


def test_api_compose_pairing_has_its_own_stricter_and_higher_priority_router() -> None:
    labels = _labels(_yaml(API_COMPOSE)["services"]["yawmi-api"])
    assert labels["traefik.http.routers.yawmi-pair.rule"] == (
        f"Host(`{API_HOST}`) && Path(`/v1/devices/pair`)"
    )
    assert int(labels["traefik.http.routers.yawmi-pair.priority"]) > int(
        labels["traefik.http.routers.yawmi-api.priority"]
    )
    assert labels["traefik.http.routers.yawmi-pair.middlewares"] == "yawmi-rl-pair"
    rl = "traefik.http.middlewares.yawmi-rl-pair.ratelimit."
    assert labels[rl + "average"] == "10"
    assert labels[rl + "period"] == "1m"


def test_pairing_route_in_the_app_is_the_one_the_router_matches() -> None:
    source = (REPO / "api" / "yawmi" / "routes" / "devices.py").read_text(encoding="utf-8")
    assert 'APIRouter(prefix="/v1"' in source
    assert '"/devices/pair"' in source


@pytest.mark.parametrize("path", [LOADER_1, LOADER_2], ids=lambda p: p.name)
def test_loaders_are_one_shot_on_the_raqib_network_only(path: Path) -> None:
    data = _yaml(path)
    assert data["name"] == "yawmi-loader"
    service = data["services"]["yawmi-loader"]
    assert service["restart"] == "no"
    assert service["networks"] == ["raqib"]
    assert service["image"] == "postgres:16-alpine"
    assert service["environment"]["PGUSER"] == "raqib_admin"
    assert service["environment"]["PGHOST"].startswith("${YAWMI_DB_HOST:?")
    assert "raqib_secrets:/run/raqib:ro" in service["volumes"]  # admin password: read-only
    assert data["networks"]["raqib"]["name"] == "${RAQIB_NETWORK:-raqib_internal}"
    assert data["volumes"]["raqib_secrets"]["external"] is True


def test_the_secrets_volume_is_external_everywhere_so_compose_never_recreates_it() -> None:
    """It is created by hand (RUNBOOK step 3): a compose change or `down -v` cannot lose the password."""
    first, second = _yaml(LOADER_1), _yaml(LOADER_2)
    # loader 1 writes the secret, loader 2 only reads it
    assert "yawmi_secrets:/run/yawmi" in first["services"]["yawmi-loader"]["volumes"]
    assert "yawmi_secrets:/run/yawmi:ro" in second["services"]["yawmi-loader"]["volumes"]
    for data in (first, second, _yaml(API_COMPOSE)):
        assert data["volumes"]["yawmi_secrets"] == {"name": "yawmi_secrets", "external": True}


@pytest.mark.parametrize("path", [LOADER_1, LOADER_2], ids=lambda p: p.name)
def test_loader_scripts_have_valid_shell_syntax(path: Path, tmp_path: Path) -> None:
    sh = shutil.which("sh")
    if sh is None:
        pytest.skip("no POSIX sh on this machine")
    script = tmp_path / "load.sh"
    script.write_text(_script(path), encoding="utf-8", newline="\n")
    result = subprocess.run([sh, "-n", str(script)], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("path", [LOADER_1, LOADER_2], ids=lambda p: p.name)
def test_loader_payloads_match_the_hash_their_script_demands(path: Path) -> None:
    hashes = build_loaders.embedded_hashes(path.read_text(encoding="utf-8"))
    assert hashes
    for key, (declared, actual) in hashes.items():
        assert declared == actual, key


def test_loader_payloads_still_match_their_sql_sources_when_those_exist() -> None:
    """Drift guard: runs once tasks 3 and 4 have put the SQL into this tree."""
    sources = {
        "0001": REPO / "api" / "db" / "migrations" / build_loaders.SCHEMA_FILE,
        "0002": REPO / "api" / "db" / "migrations" / build_loaders.ROLE_FILE,
        "seed": REPO / "api" / "db" / "seed" / "habits.sql",
    }
    present = {key: path for key, path in sources.items() if path.is_file()}
    if not present:
        pytest.skip("the SQL sources are not in this tree yet (tasks 3 and 4)")
    embedded = {}
    for path in (LOADER_1, LOADER_2):
        embedded.update(build_loaders.embedded_hashes(path.read_text(encoding="utf-8")))
    for key, path in present.items():
        expected = build_loaders.sha256(
            build_loaders.minify_sql(path.read_text(encoding="utf-8"), path.name).encode()
        )
        assert embedded.get(key, ("missing",))[0] == expected, (
            f"{path.name} changed: run python -I deploy/tools/build_loaders.py"
        )


# --- the generator: minifier and rendering -----------------------------------------------------


def test_minify_drops_comment_only_and_blank_lines_and_nothing_else() -> None:
    text = "-- header\n\nCREATE TABLE a (\n  x int, -- inline stays\n  -- inner comment\n  y int\n);\n\n"
    assert (
        build_loaders.minify_sql(text)
        == "CREATE TABLE a (\n  x int, -- inline stays\n  y int\n);\n"
    )


def test_minify_keeps_dollar_quoted_bodies_intact() -> None:
    text = "DO $$\nBEGIN\n  -- note\n  PERFORM 1;\nEND\n$$;\n"
    assert build_loaders.minify_sql(text) == "DO $$\nBEGIN\n  PERFORM 1;\nEND\n$$;\n"


def test_minify_refuses_block_comments_and_comment_lines_inside_a_string() -> None:
    with pytest.raises(ValueError):
        build_loaders.minify_sql("/* c */ SELECT 1;\n")
    with pytest.raises(ValueError):
        build_loaders.minify_sql("SELECT 'a\n-- not a comment\nb';\n")


def test_minify_accepts_escaped_quotes_and_balanced_strings() -> None:
    text = "SELECT 'it''s';\n-- c\nSELECT 'a', 'b';\n"
    assert build_loaders.minify_sql(text) == "SELECT 'it''s';\nSELECT 'a', 'b';\n"


def test_rendered_loaders_fit_and_escape_dollars_for_compose() -> None:
    schema = b"CREATE TABLE yawmi.t (x int);\n"
    role = b"DO $$ BEGIN NULL; END $$;\n"
    seed = b"INSERT INTO yawmi.t VALUES (1);\n"
    yaml = pytest.importorskip("yaml")
    for text in (
        build_loaders.render_loader_1(schema),
        build_loaders.render_loader_2(role, seed),
        build_loaders.render_loader_2(role, None),
    ):
        assert len(text) <= 8192
        script = yaml.safe_load(text)["configs"]["load"]["content"]
        assert not re.search(r"(?<!\$)\$(?!\$)", script)  # every shell `$` is doubled for compose
        assert check_compose.check_text(text) == []


def test_check_mode_flags_a_stale_loader(tmp_path: Path) -> None:
    migrations = tmp_path / "m"
    migrations.mkdir()
    (migrations / build_loaders.SCHEMA_FILE).write_bytes(b"SELECT 1;\n")
    (migrations / build_loaders.ROLE_FILE).write_bytes(b"SELECT 2;\n")
    seed = tmp_path / "seed.sql"
    seed.write_bytes(b"SELECT 3;\n")
    out = tmp_path / "out"
    args = ["--migrations-dir", str(migrations), "--seed", str(seed), "--out", str(out)]
    assert build_loaders.main(args) == 0
    assert build_loaders.main([*args, "--check"]) == 0
    (migrations / build_loaders.SCHEMA_FILE).write_bytes(b"SELECT 1; SELECT 9;\n")
    assert build_loaders.main([*args, "--check"]) == 1
    assert build_loaders.main([*args, "--check", "--out", str(tmp_path / "nowhere")]) == 1


@pytest.fixture
def generated(tmp_path: Path) -> tuple[list[str], Path]:
    """CLI arguments and the output directory of a freshly generated pair of loaders."""
    migrations = tmp_path / "m"
    migrations.mkdir()
    (migrations / build_loaders.SCHEMA_FILE).write_bytes(b"CREATE TABLE yawmi.t (x int);\n")
    (migrations / build_loaders.ROLE_FILE).write_bytes(b"SELECT 2;\n")
    seed = tmp_path / "seed.sql"
    seed.write_bytes(b"SELECT 3;\n")
    out = tmp_path / "out"
    args = ["--migrations-dir", str(migrations), "--seed", str(seed), "--out", str(out)]
    assert build_loaders.main(args) == 0
    assert build_loaders.main([*args, "--check"]) == 0
    return args, out


def _edit(path: Path, change: Callable[[str], str]) -> None:
    text = path.read_bytes().decode("utf-8")
    edited = change(text)
    assert edited != text
    path.write_bytes(edited.encode("utf-8"))


def test_check_mode_flags_a_hand_edit_of_a_committed_loader(generated) -> None:
    args, out = generated
    _edit(out / build_loaders.LOADER_1, lambda text: text + "# edited by hand\n")
    assert build_loaders.main([*args, "--check"]) == 1


def test_check_mode_flags_a_hand_edited_script_line(generated) -> None:
    args, out = generated
    _edit(
        out / build_loaders.LOADER_2,
        lambda text: text.replace("role step done", "role step finished"),
    )
    assert build_loaders.main([*args, "--check"]) == 1


def test_check_mode_flags_a_change_to_a_script_template(
    generated, monkeypatch: pytest.MonkeyPatch
) -> None:
    args, _ = generated
    for name in ("_LOADER_1", "_LOADER_2", "_COMPOSE"):
        original = getattr(build_loaders, name)
        marker = original.splitlines()[1]  # a line that exists in each template
        with monkeypatch.context() as patch:
            patch.setattr(build_loaders, name, original.replace(marker, marker + " ", 1))
            assert build_loaders.main([*args, "--check"]) == 1, name
    assert build_loaders.main([*args, "--check"]) == 0  # and the patches are gone again


def test_check_mode_flags_a_crlf_copy_and_a_damaged_payload(generated) -> None:
    args, out = generated
    original = (out / build_loaders.LOADER_1).read_bytes()
    (out / build_loaders.LOADER_1).write_bytes(original.replace(b"\n", b"\r\n"))
    assert build_loaders.main([*args, "--check"]) == 1
    (out / build_loaders.LOADER_1).write_bytes(original)
    not_gzip = base64.b64encode(b"valid base64, but not a gzip stream").decode("ascii")
    _edit(
        out / build_loaders.LOADER_1,
        lambda text: re.sub(
            r"(  p0001:\n    content: \|\n)(?:      \S+\n?)+", rf"\1      {not_gzip}\n", text
        ),
    )
    assert build_loaders.main([*args, "--check"]) == 1  # reported as stale, not a crash


def test_check_mode_accepts_the_same_sql_packed_by_another_compressor(generated) -> None:
    """The packed bytes are compared by what they unpack to, so another zlib build is no drift."""
    args, out = generated
    path = out / build_loaders.LOADER_1
    text = path.read_bytes().decode("utf-8")
    body = re.search(r"content: \|\n((?:      \S+\n?)+)", text.split("  p0001:")[1])[1]
    sql = gzip.decompress(base64.b64decode("".join(body.split())))
    other = base64.b64encode(gzip.compress(sql, 1, mtime=12345)).decode("ascii")
    assert other != "".join(body.split())
    path.write_bytes(text.replace(body, f"      {other}\n").encode("utf-8"))
    assert build_loaders.main([*args, "--check"]) == 0


# --- the loader scripts, run against stub psql/pg_isready --------------------------------------

STUB_PSQL = """#!/bin/sh
i=$(($(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1))
echo "$i" > "$STUB_DIR/count"
{
  echo "argv: $*"
  echo "PGUSER=${PGUSER:-}"
  echo "PGPASSWORD=${PGPASSWORD:-}"
  if [ -s "$SECRET_FILE" ]; then echo "secret_exists=yes"; else echo "secret_exists=no"; fi
} > "$STUB_DIR/psql.$i.meta"
cat > "$STUB_DIR/psql.$i.sql"
"""
ADMIN_PW = "admin-pw-for-tests"


def _script(path: Path) -> str:
    """The loader's shell script as the container sees it (compose `$$` collapsed to `$`)."""
    return _yaml(path)["configs"]["load"]["content"].replace("$$", "$")


def _payload_text(compose_text: str, key: str) -> str:
    return "".join(
        re.search(rf"^  p{key}:\n    content: \|\n((?:      \S+\n?)+)", compose_text, re.MULTILINE)[
            1
        ].split()
    )


class Sandbox:
    """A directory standing in for the container's /run/raqib, /run/yawmi, /yawmi/in and /tmp."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.stub = root / "stub"
        for name in ("raqib", "yawmi", "in", "tmp", "stub", "bin"):
            (root / name).mkdir()
        (root / "raqib" / "admin_pw").write_text(ADMIN_PW, encoding="utf-8")
        stubs = {
            "psql": STUB_PSQL,
            "pg_isready": '#!/bin/sh\necho called >> "$STUB_DIR/pg_isready"\n',
            "chown": "#!/bin/sh\nexit 0\n",
        }
        for name, body in stubs.items():
            stub = root / "bin" / name
            stub.write_text(body, encoding="utf-8", newline="\n")
            stub.chmod(0o755)

    @property
    def secret(self) -> Path:
        return self.root / "yawmi" / "yawmi_api_pw"

    def psql_calls(self) -> int:
        count = self.stub / "count"
        return int(count.read_text()) if count.exists() else 0

    def sql(self, n: int) -> str:
        return (self.stub / f"psql.{n}.sql").read_text(encoding="utf-8")

    def meta(self, n: int) -> str:
        return (self.stub / f"psql.{n}.meta").read_text(encoding="utf-8")

    def install(self, compose_text: str, script: str, keys: tuple[str, ...]) -> Path:
        posix = self.root.as_posix()
        for old, new in (
            ("/run/raqib", f"{posix}/raqib"),
            ("/run/yawmi", f"{posix}/yawmi"),
            ("/yawmi/in", f"{posix}/in"),
            ("/tmp/", f"{posix}/tmp/"),
        ):
            script = script.replace(old, new)
        for key in keys:
            (self.root / "in" / f"{key}.b64").write_text(
                _payload_text(compose_text, key), encoding="utf-8", newline="\n"
            )
        path = self.root / "load.sh"
        path.write_text(script, encoding="utf-8", newline="\n")
        return path

    def run(self, script: Path) -> subprocess.CompletedProcess[str]:
        sh = shutil.which("sh")
        if sh is None:
            pytest.skip("no POSIX sh on this machine")
        env = {
            **os.environ,
            "PATH": f"{self.root / 'bin'}{os.pathsep}{os.environ['PATH']}",
            "STUB_DIR": self.stub.as_posix(),
            "SECRET_FILE": self.secret.as_posix(),
        }
        return subprocess.run(
            [sh, str(script)],
            check=False,
            env=env,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
        )


def _synthetic(kind: str, *, seed: bool = True) -> tuple[str, str, tuple[str, ...]]:
    if kind == "1":
        text = build_loaders.render_loader_1(b"CREATE TABLE yawmi.t (x int);\nBEGIN;\nCOMMIT;\n")
        keys: tuple[str, ...] = ("0001",)
    else:
        text = build_loaders.render_loader_2(
            b"SELECT 2;\n", b"INSERT INTO yawmi.habits VALUES (1);\n" if seed else None
        )
        keys = ("0002", "seed") if seed else ("0002",)
    yaml = pytest.importorskip("yaml")
    script = yaml.safe_load(text)["configs"]["load"]["content"].replace("$$", "$")
    return text, script, keys


def test_loader_1_generates_the_secret_once_before_any_sql_and_never_prints_it(
    tmp_path: Path,
) -> None:
    box = Sandbox(tmp_path)
    text, script, keys = _synthetic("1")
    path = box.install(text, script, keys)

    first = box.run(path)
    assert first.returncode == 0, first.stdout + first.stderr
    secret = box.secret.read_text(encoding="utf-8")
    assert re.fullmatch(r"[0-9a-f]{64}", secret)
    assert "secret_exists=yes" in box.meta(1)  # ordering: the secret precedes the first SQL
    assert "generated yawmi_api_pw" in first.stdout

    second = box.run(path)
    assert second.returncode == 0, second.stdout + second.stderr
    assert box.secret.read_text(encoding="utf-8") == secret  # kept, not regenerated
    assert "generated yawmi_api_pw" not in second.stdout

    everything = first.stdout + first.stderr + second.stdout + second.stderr
    for n in range(1, box.psql_calls() + 1):
        everything += box.sql(n) + box.meta(n).replace(f"PGPASSWORD={ADMIN_PW}", "")
    assert secret not in everything
    assert ADMIN_PW not in first.stdout + first.stderr  # the admin password is env-only


def test_loader_1_applies_the_schema_in_one_transaction_with_its_ledger_row(tmp_path: Path) -> None:
    box = Sandbox(tmp_path)
    text, script, keys = _synthetic("1")
    result = box.run(box.install(text, script, keys))
    assert result.returncode == 0, result.stdout + result.stderr
    sql = box.sql(1)
    assert (
        sql.index("BEGIN;") < sql.index(r"\i ") < sql.index("INSERT INTO yawmi.schema_migrations")
    )
    assert sql.index("INSERT INTO yawmi.schema_migrations") < sql.index("COMMIT;")
    assert "schema_tables=" in sql and "FROM information_schema.tables" in sql
    assert not (box.root / "tmp" / "0001.sql").exists()  # the trap removed the unpacked file
    assert "OK" in result.stdout  # sha256sum -c said so


def test_loader_1_refuses_a_payload_that_does_not_match_its_hash(tmp_path: Path) -> None:
    box = Sandbox(tmp_path)
    text, script, keys = _synthetic("1")
    path = box.install(text, script, keys)
    tampered = base64.b64encode(gzip.compress(b"DROP SCHEMA yawmi CASCADE;\n")).decode()
    (box.root / "in" / "0001.b64").write_text(tampered, encoding="utf-8", newline="\n")
    result = box.run(path)
    assert result.returncode != 0
    assert box.psql_calls() == 0
    assert not box.secret.exists()  # nothing was done before the check


def test_loader_2_refuses_to_run_without_the_secret(tmp_path: Path) -> None:
    box = Sandbox(tmp_path)
    text, script, keys = _synthetic("2")
    result = box.run(box.install(text, script, keys))
    assert result.returncode != 0
    assert "run loader 1 first" in result.stdout
    assert box.psql_calls() == 0


def test_loader_2_passes_the_password_by_file_and_env_never_by_argument(tmp_path: Path) -> None:
    box = Sandbox(tmp_path)
    secret = "ab" * 32
    box.secret.write_text(secret, encoding="utf-8")
    text, script, keys = _synthetic("2")
    result = box.run(box.install(text, script, keys))
    assert result.returncode == 0, result.stdout + result.stderr

    assert box.psql_calls() == 2
    admin_sql, api_sql = box.sql(1), box.sql(2)
    # The password goes into exactly ONE statement (the ALTER ROLE), read from the file just before
    # it, inside a transaction that first switches off every kind of statement logging, and the
    # psql variable is dropped right after. 0002 itself gets no password setting.
    assert admin_sql.count(":'yawmi_api_pw'") == 1
    assert admin_sql.count(r"\set yawmi_api_pw") == 1
    assert "yawmi_migrate" not in admin_sql
    set_at = admin_sql.index(r"\set yawmi_api_pw `cat ")
    begin_at = admin_sql.index("BEGIN;", set_at)
    alter_at = admin_sql.index("ALTER ROLE yawmi_api PASSWORD :'yawmi_api_pw';")
    for setting in (
        "SET LOCAL log_statement = 'none';",
        "SET LOCAL log_min_error_statement = 'panic';",
        "SET LOCAL log_min_duration_statement = -1;",
    ):
        assert begin_at < admin_sql.index(setting) < alter_at, setting
    commit_at = admin_sql.index("COMMIT;", alter_at)
    assert alter_at < commit_at < admin_sql.index(r"\unset yawmi_api_pw")
    assert admin_sql.index(r"\i ") < set_at  # 0002 is applied before the password is touched
    # the seed goes in after the role is set up, in a transaction of its own
    seed_at = admin_sql.index("seed.sql")
    assert (
        admin_sql.index("ALTER ROLE yawmi_api")
        < admin_sql.rindex("BEGIN;", 0, seed_at)
        < seed_at
        < admin_sql.index("COMMIT;", seed_at)
    )
    # the second psql run logs in as yawmi_api, with the password from the environment
    assert "PGUSER=yawmi_api" in box.meta(2)
    assert f"PGPASSWORD={secret}" in box.meta(2)
    assert "PGUSER=raqib_admin" not in box.meta(2)
    for n in (1, 2):
        assert secret not in box.sql(n)
        assert secret not in box.meta(n).split("PGPASSWORD=")[0]  # not in argv
    assert secret not in result.stdout + result.stderr
    assert "denied_probes" in api_sql and "yawmi.events" in api_sql and "raqib.kpis" in api_sql


def test_loader_2_without_an_embedded_seed_stops_before_touching_anything(tmp_path: Path) -> None:
    box = Sandbox(tmp_path)
    box.secret.write_text("ab" * 32, encoding="utf-8")
    text, script, keys = _synthetic("2", seed=False)
    result = box.run(box.install(text, script, keys))
    assert result.returncode == 1
    assert "not embedded" in result.stdout
    assert box.psql_calls() == 0
    assert not (box.stub / "pg_isready").exists()  # it did not even wait for the database


# --- the image: Dockerfile, entrypoint, workflow -----------------------------------------------

DOCKERFILE = (REPO / "api" / "Dockerfile").read_text(encoding="utf-8")
ENTRYPOINT = REPO / "api" / "docker" / "entrypoint.sh"
WORKFLOW = (REPO / ".github" / "workflows" / "api-image.yml").read_text(encoding="utf-8")


def test_dockerfile_base_images_are_pinned_slim_python_313() -> None:
    bases = re.findall(r"^FROM (\S+)", DOCKERFILE, re.MULTILINE)
    assert bases and all(re.fullmatch(r"python:3\.13\.\d+-slim", base) for base in bases)


def test_dockerfile_installs_locked_dependencies_without_dev_and_pins_uv() -> None:
    assert "uv sync --frozen --no-dev" in DOCKERFILE
    assert re.search(r"pip install uv==\d+\.\d+\.\d+", DOCKERFILE)
    assert "COPY pyproject.toml uv.lock" in DOCKERFILE


def test_dockerfile_runs_as_uid_10001_the_owner_the_loader_gives_the_secret() -> None:
    assert "--uid 10001" in DOCKERFILE
    assert re.search(r"^USER 10001:10001$", DOCKERFILE, re.MULTILINE)
    assert "10001:10001" in LOADER_1.read_text(encoding="utf-8")  # chown in the schema loader


def test_dockerfile_command_healthcheck_and_entrypoint() -> None:
    assert "uvicorn yawmi.main:app" in DOCKERFILE.replace('", "', " ").replace('"', "")
    assert '"--host", "0.0.0.0", "--port", "8000"' in DOCKERFILE
    assert "--no-access-log" in DOCKERFILE  # the app logs paths without query strings itself
    assert re.search(r"^HEALTHCHECK .*\n\s+CMD .*/v1/health/live", DOCKERFILE, re.MULTILINE)
    assert 'ENTRYPOINT ["/usr/local/bin/yawmi-entrypoint"]' in DOCKERFILE


def test_dockerfile_bakes_in_no_secret_and_no_database_url() -> None:
    for line in DOCKERFILE.splitlines():
        if line.startswith(("ENV", "ARG")):
            assert not re.search(r"SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL", line, re.IGNORECASE)


def test_entrypoint_is_lf_and_executable_in_git() -> None:
    assert b"\r" not in ENTRYPOINT.read_bytes()
    listing = subprocess.run(
        ["git", "ls-files", "-s", "api/docker/entrypoint.sh"],
        check=False,
        cwd=REPO,
        capture_output=True,
        text=True,
    ).stdout
    if listing:  # empty only outside a git checkout
        assert listing.startswith("100755")


def _entrypoint(env: dict[str, str], args: list[str]) -> subprocess.CompletedProcess[str]:
    sh = shutil.which("sh")
    if sh is None:
        pytest.skip("no POSIX sh on this machine")
    clean = {k: v for k, v in os.environ.items() if not k.startswith("YAWMI_")}
    clean["PATH"] = f"{Path(sys.executable).parent}{os.pathsep}{clean['PATH']}"
    return subprocess.run(
        [sh, str(ENTRYPOINT), *args],
        check=False,
        env={**clean, **env},
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
    )


PRINT_URL = ["python", "-c", "import os; print(os.environ['YAWMI_DATABASE_URL'])"]


def test_entrypoint_builds_the_url_and_percent_encodes_the_password(tmp_path: Path) -> None:
    awkward = "p@ss:w/rd%#?&=+ é"
    pw_file = tmp_path / "pw"
    pw_file.write_text(awkward + "\n", encoding="utf-8")
    result = _entrypoint(
        {"YAWMI_DB_HOST": "db.internal", "YAWMI_DB_PASSWORD_FILE": pw_file.as_posix()}, PRINT_URL
    )
    assert result.returncode == 0, result.stderr
    url = urlsplit(result.stdout.strip())
    assert (url.scheme, url.username, url.hostname, url.port, url.path) == (
        "postgresql",
        "yawmi_api",
        "db.internal",
        5432,
        "/raqib",
    )
    assert unquote(url.password or "") == awkward
    assert awkward not in result.stdout


def test_entrypoint_honours_user_port_and_database_overrides(tmp_path: Path) -> None:
    pw_file = tmp_path / "pw"
    pw_file.write_text("x", encoding="utf-8")
    env = {
        "YAWMI_DB_HOST": "h",
        "YAWMI_DB_USER": "u",
        "YAWMI_DB_PORT": "6543",
        "YAWMI_DB_NAME": "n",
        "YAWMI_DB_PASSWORD_FILE": pw_file.as_posix(),
    }
    url = urlsplit(_entrypoint(env, PRINT_URL).stdout.strip())
    assert (url.username, url.port, url.path) == ("u", 6543, "/n")


def test_entrypoint_leaves_a_ready_made_url_alone() -> None:
    result = _entrypoint({"YAWMI_DATABASE_URL": "postgresql:///already"}, PRINT_URL)
    assert result.stdout.strip() == "postgresql:///already"


@pytest.mark.parametrize("case", ["no-host", "no-file", "empty-file"])
def test_entrypoint_fails_fast_and_never_runs_the_command(tmp_path: Path, case: str) -> None:
    empty = tmp_path / "empty"
    empty.write_text("\n", encoding="utf-8")
    env = {
        "no-host": {"YAWMI_DB_PASSWORD_FILE": empty.as_posix()},
        "no-file": {"YAWMI_DB_HOST": "h", "YAWMI_DB_PASSWORD_FILE": (tmp_path / "x").as_posix()},
        "empty-file": {"YAWMI_DB_HOST": "h", "YAWMI_DB_PASSWORD_FILE": empty.as_posix()},
    }[case]
    result = _entrypoint(env, ["python", "-c", "print('ran')"])
    assert result.returncode != 0
    assert "ran" not in result.stdout


def test_workflow_triggers_only_on_api_tags_and_pushes_the_private_image() -> None:
    assert re.search(r'tags:\s*\n\s*- "api-v\*"', WORKFLOW)
    assert "branches" not in WORKFLOW and "pull_request" not in WORKFLOW
    assert "IMAGE: ghcr.io/nexgen94/yawmi-api" in WORKFLOW
    assert "packages: write" in WORKFLOW
    assert "--password-stdin" in WORKFLOW
    assert ":latest" not in WORKFLOW


def test_workflow_actions_are_pinned_to_full_commit_shas() -> None:
    uses = re.findall(r"uses:\s*(\S+)", WORKFLOW)
    assert uses
    for ref in uses:
        assert re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", ref), ref


# --- the runbook -------------------------------------------------------------------------------

RUNBOOK = (REPO / "deploy" / "RUNBOOK.md").read_text(encoding="utf-8")
APPROVAL = "يحتاج موافقة عبدالله المستقلة"


def _runbook_steps() -> dict[int, str]:
    parts = re.split(r"^## الخطوة (\d+) · ", RUNBOOK, flags=re.MULTILINE)
    return {int(number): body for number, body in zip(parts[1::2], parts[2::2], strict=True)}


def test_every_server_step_asks_for_separate_approval_and_has_a_rollback() -> None:
    steps = _runbook_steps()
    assert sorted(steps) == list(range(12))
    for number, body in steps.items():
        assert APPROVAL in body, number
        assert "التراجع" in body, number


def test_runbook_covers_the_required_sequence_and_the_ghcr_login_rules() -> None:
    steps = _runbook_steps()
    expected = {
        1: "backup",
        3: "yawmi-db-1-schema.yml",
        4: "yawmi-db-2-role.yml",
        6: "docker login ghcr.io",
        7: "yawmi-api.api.yml",
        8: "/v1/health/live",
        9: "pair-code",
        10: "service-token",
    }
    for number, marker in expected.items():
        assert marker in steps[number], (number, marker)
    assert "read:packages" in steps[6]
    assert "يكتب عبدالله الرمز بنفسه" in steps[6]


def test_runbook_carries_no_ip_no_key_prefix_and_no_carriage_return() -> None:
    assert "\r" not in RUNBOOK
    assert not check_compose._IPV4.search(RUNBOOK)
    assert not check_compose._API_KEY_PREFIX.search(RUNBOOK)


def test_runbook_puts_loader_2_after_the_w9_tables_and_after_loader_1() -> None:
    steps = _runbook_steps()
    assert "الخطوة 2" in steps[4] and "W9" in steps[4]
    assert "الخطوة 3" in steps[4]
    assert "raqib.notion_milestones" in RUNBOOK and "raqib.notion_cards" in RUNBOOK
    assert "لا يُشغَّل قبل جدولَي W9" in RUNBOOK
    table = RUNBOOK.split("## 1. الترتيب", 1)[1].split("## الخطوة 0", 1)[0]
    rows = {int(m[1]): m[0] for m in re.finditer(r"^\| (\d+) \|.*$", table, re.MULTILINE)}
    assert "W9-loader-1-tables" in rows[2]
    assert "yawmi-db-1-schema.yml" in rows[3]
    assert "yawmi-db-2-role.yml" in rows[4]
    assert "بعد الخطوتين 2 و3" in rows[4]


def test_runbook_says_a_service_token_is_revoked_only_by_rotating_the_jwt_secret() -> None:
    assert "فلا يُبطَل إلا بتدوير `YAWMI_JWT_SECRET`" in RUNBOOK
    assert "السبيل الوحيد لإبطاله هو تدوير `YAWMI_JWT_SECRET`" in _runbook_steps()[10]
    assert "عديم الحالة" in _runbook_steps()[10]


def test_runbook_step_4_separates_verification_only_failures_from_failures_that_change_nothing() -> (
    None
):
    body = _runbook_steps()[4]
    marker = "system habits upserted"
    assert f"بعد سطر `yawmi-loader: {marker}`" in body
    after = body.split(f"بعد سطر `yawmi-loader: {marker}`", 1)[1]
    assert "فشل تحقق فقط" in after and "التغييرات مثبتة" in after
    assert "فيتخطى `0002`" in after  # and what to do: fix the cause, re-run the same loader


def test_runbook_documents_how_the_password_is_kept_out_of_logs() -> None:
    fixed_rules = RUNBOOK.split("### متغيرات المشروع", 1)[0]
    for setting in ("log_statement", "log_min_error_statement", "log_min_duration_statement"):
        assert setting in fixed_rules
    assert "ALTER ROLE yawmi_api PASSWORD" in fixed_rules
    assert "permission denied to set parameter" in fixed_rules


def test_runbook_creates_the_external_secrets_volume_before_loader_1() -> None:
    body = _runbook_steps()[3]
    assert body.index("docker volume create yawmi_secrets") < body.index("3ب")
    assert "docker volume rm yawmi_secrets" in body
    assert "external: true" in RUNBOOK.split("### متغيرات المشروع", 1)[0]


def test_runbook_counts_two_new_projects_not_three() -> None:
    assert "مشروعان جديدان مستقلان" in RUNBOOK
    assert "ثلاثة مشاريع" not in RUNBOOK


def test_runbook_step_6_ends_with_docker_logout_after_the_pull() -> None:
    body = _runbook_steps()[6]
    assert body.index("docker pull") < body.index("docker logout ghcr.io")
    sub_steps = re.findall(r"^(\d)\. ", body, re.MULTILINE)
    last = body.split(f"\n{sub_steps[-1]}. ", 1)[1]
    assert last.startswith("**آخر خطوة فرعية") and "docker logout ghcr.io" in last


def test_runbook_pulls_and_requires_the_web_image_before_the_project_is_created() -> None:
    # The compose file holds both services, so a project created from it needs both private
    # images already on the server (the login is closed again right after step 6).
    steps = _runbook_steps()
    assert "yawmi-web" in steps[6]
    assert "yawmi-web" in steps[7]
    row_7 = next(line for line in RUNBOOK.splitlines() if line.startswith("| 7 |"))
    assert "yawmi-web" in row_7


# --- the yawmi-web service and its image workflow ------------------------------------------------

WEB_WORKFLOW_PATH = REPO / ".github" / "workflows" / "web-image.yml"


def test_web_service_is_hardened_and_routed_after_the_api() -> None:
    data = _yaml(API_COMPOSE)
    service = data["services"]["yawmi-web"]
    assert re.fullmatch(r"ghcr\.io/nexgen94/yawmi-web:\d+\.\d+\.\d+", service["image"])
    assert service["read_only"] is True
    assert service["tmpfs"] == ["/tmp"]
    assert service["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in service["security_opt"]
    for absent in ("volumes", "environment", "env_file", "ports", "privileged", "user"):
        assert absent not in service, absent
    assert service["networks"] == ["n8n"]
    labels = _labels(service)
    assert labels["traefik.http.routers.yawmi-web.priority"] == "1"
    assert labels["traefik.http.services.yawmi-web.loadbalancer.server.port"] == "8080"
    api = _labels(data["services"]["yawmi-api"])
    assert int(api["traefik.http.routers.yawmi-api.priority"]) > 1


def test_web_workflow_is_pinned_least_privilege_and_has_no_expressions_in_scripts() -> None:
    text = WEB_WORKFLOW_PATH.read_text(encoding="utf-8")
    uses = re.findall(r"uses:\s*(\S+)", text)
    assert uses
    for ref in uses:
        assert re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", ref), ref
    data = _yaml(WEB_WORKFLOW_PATH)
    assert data["permissions"] == {"contents": "read"}
    assert data["jobs"]["image"]["permissions"] == {"contents": "read", "packages": "write"}
    for step in data["jobs"]["image"]["steps"]:
        assert "${{" not in step.get("run", ""), step.get("name")
    assert ":latest" not in text


def test_web_workflow_only_publishes_tags_that_are_on_main_and_checks_the_running_image() -> None:
    text = WEB_WORKFLOW_PATH.read_text(encoding="utf-8")
    assert "fetch-depth: 0" in text
    assert "merge-base --is-ancestor" in text and "origin/main" in text
    assert "--cap-drop ALL" in text and "--security-opt no-new-privileges:true" in text
    assert "State.Health.Status" in text and "healthy" in text
    assert "--ignore-scripts" not in text  # the install flag belongs to the Dockerfile only
    for needle in ("gzip", "nosniff", "no-referrer", "/sw.js", "immutable"):
        assert needle in text, needle
    docker = (REPO / "web" / "Dockerfile").read_text(encoding="utf-8")
    assert "npm ci --ignore-scripts" in docker
    assert "127.0.0.1:8080/healthz" in docker


def test_gitignore_keeps_env_variants_and_key_files_out() -> None:
    """M-6: `.env.local`, `.env.production`, `vapid.key` and the like are never committed."""
    lines = (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()
    for pattern in (".env", ".env.*", "*.pem", "*.key"):
        assert pattern in lines


# --- D-5, D-6, D-7: one tag, no pull, required host and resolver ----------------------------------


def test_api_compose_never_pulls_either_image() -> None:
    """D-6: the images are private and compose must not try to pull them after `docker logout`."""
    services = _yaml(API_COMPOSE)["services"]
    assert {name: s.get("pull_policy") for name, s in services.items()} == {
        "yawmi-api": "never",
        "yawmi-web": "never",
    }


def test_api_host_and_cert_resolver_are_required_wherever_they_are_used() -> None:
    text = API_COMPOSE.read_text(encoding="utf-8")
    for name, guarded in (("YAWMI_API_HOST", API_HOST), ("TRAEFIK_CERT_RESOLVER", CERT_RESOLVER)):
        uses = re.findall(r"\$\{" + name + r"[^}]*\}", text)
        assert len(uses) == 3, name
        assert set(uses) == {guarded}, name
    services = _yaml(API_COMPOSE)["services"]
    for service, router in (
        ("yawmi-api", "yawmi-api"),
        ("yawmi-api", "yawmi-pair"),
        ("yawmi-web", "yawmi-web"),
    ):
        labels = _labels(services[service])
        assert labels[f"traefik.http.routers.{router}.tls.certresolver"] == CERT_RESOLVER
        assert f"Host(`{API_HOST}`)" in labels[f"traefik.http.routers.{router}.rule"]


def test_the_keygen_runs_the_same_api_image_tag_as_the_api_project() -> None:
    """D-5: one image is built from main; a second tag would exist only if pushed again."""
    api_image = _yaml(API_COMPOSE)["services"]["yawmi-api"]["image"]
    keygen_image = _yaml(KEYGEN)["services"]["yawmi-vapid-keygen"]["image"]
    assert keygen_image == api_image
    tags = set(
        re.findall(r"ghcr\.io/nexgen94/yawmi-api:(\S+)", API_COMPOSE.read_text(encoding="utf-8"))
    )
    tags |= set(
        re.findall(r"ghcr\.io/nexgen94/yawmi-api:(\S+)", KEYGEN.read_text(encoding="utf-8"))
    )
    assert len(tags) == 1


# --- the runbook lines of the final review (D-1 … D-10, I-13(b)) ----------------------------------

_SECOND_PERSON = re.compile(
    r"(?<![\u0621-\u064a])(أنت|انت|عليك|لديك|عندك|يمكنك|تأكد|تأكدي|اكتب|اكتبي|شغّل|شغل|افتح|"
    r"افتحي|انتظر|انتظري|احذف|احذفي|أرسل|ارسل|أرسلي|نفّذ|نفذ|نفّذي|استخدم|استخدمي)(?![\u0621-\u064a])"
)


def test_runbook_role_check_expects_postgres_booleans_as_t_and_f() -> None:
    """D-1: concat_ws prints booleans with their output function: `f`/`t`, not false/true."""
    body = _runbook_steps()[4]
    assert "yawmi-verify api_role=f,f,f,5,t" in body
    assert "api_role=false" not in RUNBOOK


def test_runbook_loader_1_lists_the_two_already_exists_notices() -> None:
    """D-2: loader 1 creates the schema and ledger, then 0001 creates them again IF NOT EXISTS."""
    body = _runbook_steps()[3]
    assert 'NOTICE:  schema "yawmi" already exists, skipping' in body
    assert 'NOTICE:  relation "schema_migrations" already exists, skipping' in body


def test_runbook_has_a_curl_smoke_test_after_pairing_that_ends_with_the_cli_revoke() -> None:
    """D-3 and C-1(c): the first real request is the operator's, with expected outputs."""
    body = _runbook_steps()[9]
    smoke = body.split("9أ", 1)[1]
    for marker in (
        "/v1/devices/pair",
        "access_token",
        "/v1/today",
        "/v1/events",
        '{"accepted":1,"duplicates":0}',
        '{"accepted":0,"duplicates":1}',
        "/v1/habits",
        "yawmi-admin revoke --id",
    ):
        assert marker in smoke, marker
    assert smoke.index("/v1/today") < smoke.index("/v1/events") < smoke.index("/v1/habits")
    assert smoke.index("/v1/habits") < smoke.index("yawmi-admin revoke --id")
    assert "يُدخل عبدالله الكود في التطبيق" not in RUNBOOK  # there is no pairing screen yet


def test_runbook_issues_a_service_token_only_on_demand_for_one_hour() -> None:
    """D-4: no standing year-long token; revocation goes through the CLI (I-2)."""
    body = _runbook_steps()[10]
    assert "--ttl-hours 1" in body
    assert "--ttl-hours 8760" not in RUNBOOK
    assert "عند الحاجة" in body
    row_10 = next(line for line in RUNBOOK.splitlines() if line.startswith("| 10 |"))
    assert "ولإبطال الأجهزة" not in row_10
    assert "yawmi-admin revoke" in RUNBOOK.split("**11و", 1)[1]
    assert "برمز الخدمة (الخطوة 10)" not in RUNBOOK


def test_runbook_checks_the_web_container_and_reads_404_not_502_for_an_unhealthy_api() -> None:
    """D-8."""
    steps = _runbook_steps()
    assert "docker ps --filter name=yawmi-web" in steps[7]
    assert "yawmi-web Up … (healthy)" in steps[7]
    failure = steps[8].split("**إن فشل:**", 1)[1]
    assert "502` ← الحاوية ليست `healthy`" not in failure
    assert "nginx" in failure and "404" in failure
    assert "`main`" in RUNBOOK.split("**11أ", 1)[1].split("**11ب", 1)[0]
    assert "`main`" in steps[5]


def test_runbook_step_0_checks_the_raqib_network_volume_and_superuser() -> None:
    """D-10."""
    body = _runbook_steps()[0]
    assert "docker network inspect raqib_internal" in body
    assert "docker volume inspect raqib_secrets" in body
    assert "rolsuper" in body and "raqib_admin" in body


def test_runbook_proves_the_pairing_rate_limit_once() -> None:
    """I-13(b): 20 quick wrong codes must meet 429 at Traefik."""
    body = _runbook_steps()[8]
    assert "/v1/devices/pair" in body
    assert "seq 1 20" in body
    assert "429" in body


def test_runbook_step_3_rollback_removes_the_stopped_loader_project() -> None:
    rollback = _runbook_steps()[3].split("**التراجع**", 1)[1]
    assert "yawmi-loader" in rollback


def test_runbook_names_one_api_tag_for_push_and_says_compose_never_pulls() -> None:
    """D-5 and D-6."""
    assert "api-v0.2.0" not in RUNBOOK
    assert "yawmi-api:0.2.0" not in RUNBOOK
    assert "pull_policy: never" in _runbook_steps()[6]


def test_runbook_lines_added_by_the_final_review_address_no_one() -> None:
    hits = _SECOND_PERSON.findall(RUNBOOK)
    assert hits == []


# --- ci (D-9, M-9) -------------------------------------------------------------------------------


def test_api_image_workflow_only_publishes_tags_that_are_on_main() -> None:
    """D-9: a tag on an unreviewed branch must never publish an API image."""
    assert "fetch-depth: 0" in WORKFLOW
    assert "merge-base --is-ancestor" in WORKFLOW and "origin/main" in WORKFLOW
    assert WORKFLOW.index("merge-base --is-ancestor") < WORKFLOW.index("docker build")
    assert WORKFLOW.index("merge-base --is-ancestor") < WORKFLOW.index("docker push")


def test_web_tests_workflow_installs_without_running_package_scripts() -> None:
    """M-9: like the Dockerfile, CI never runs install scripts of the app's dependencies."""
    text = (REPO / ".github" / "workflows" / "web-tests.yml").read_text(encoding="utf-8")
    installs = re.findall(r"run: (npm ci[^\n]*)", text)
    assert installs and all(line == "npm ci --ignore-scripts" for line in installs), installs
