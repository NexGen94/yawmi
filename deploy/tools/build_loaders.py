"""Generate the three one-shot loader compose files from the SQL sources.

    python -I deploy/tools/build_loaders.py            # write deploy/compose/yawmi-db-*.yml
    python -I deploy/tools/build_loaders.py --check    # fail if a file differs from a fresh render

The Hostinger Docker Manager takes one compose file of at most 8192 characters and has no file
upload, so each SQL file travels inside the compose file as gzip + base64 (the pattern of
gate0/build_loader_chunks.py) and the loader refuses to run it unless its sha256 matches the one
written next to it. Sources, all read from this repository:

    api/db/migrations/0001_yawmi_schema.sql   loader 1  (schema, plus the generated API password)
    api/db/migrations/0002_yawmi_role.sql     loader 2  (role and grants)
    api/db/seed/habits.sql                    loader 2  (the system habits, written by task 4)
    api/db/migrations/0003_yawmi_web.sql      loader 3  (desktop web tables, columns, view, grants)

Comment-only and blank lines are dropped before packing (`minify_sql`): without that, 0001 and
0002 do not fit beside their scripts. Nothing else changes, and the packed text is what the
loader hashes. If the seed does not exist yet, loader 2 is generated with a guard that stops it
before it touches anything; regenerate once the seed is committed.

Standard library only. `$` is doubled for compose in every script, and no real value is written
anywhere: host and network names are compose variables, and the password lives in the
`yawmi_secrets` volume.
"""

import argparse
import base64
import gzip
import hashlib
import re
import sys
import textwrap
import zlib
from collections.abc import Sequence
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_MIGRATIONS = REPO / "api" / "db" / "migrations"
DEFAULT_SEED = REPO / "api" / "db" / "seed" / "habits.sql"
DEFAULT_OUT = REPO / "deploy" / "compose"

MAX_CHARS = 8192
LOADER_1 = "yawmi-db-1-schema.yml"
LOADER_2 = "yawmi-db-2-role.yml"
LOADER_3 = "yawmi-db-3-web.yml"
SCHEMA_FILE = "0001_yawmi_schema.sql"
ROLE_FILE = "0002_yawmi_role.sql"
WEB_FILE = "0003_yawmi_web.sql"

# --- shell scripts (plain `$` here; `_compose_escape` doubles it for compose) --------------------

_HEAD = r"""#!/bin/sh
set -e
umask 077
trap 'rm -f /tmp/*.sql' EXIT
PGPASSWORD="$(cat /run/raqib/admin_pw)"
export PGPASSWORD
n=0
until pg_isready -q; do n=$((n+1)); [ $n -lt 60 ] || { echo "yawmi-loader: database not ready"; exit 1; }; sleep 2; done
PSQL="psql -v ON_ERROR_STOP=1 -v VERBOSITY=terse --no-psqlrc -q"
"""

# Unpack, refuse on a hash mismatch, print the hash, and cut the file's own BEGIN;/COMMIT; pair
# (the loader wraps the file and its ledger row in one transaction, as api/yawmi/db/migrate.py).
_UNPACK = r"""base64 -d /yawmi/in/@KEY@.b64 | gunzip -c > /tmp/@KEY@.sql
printf '%s  %s\n' @SHA@ /tmp/@KEY@.sql | sha256sum -c -
sha256sum /tmp/@KEY@.sql
sed -i -e '/^[[:space:]]*BEGIN;[[:space:]]*$/d' -e '/^[[:space:]]*COMMIT;[[:space:]]*$/d' /tmp/@KEY@.sql
"""

_LOADER_1 = (
    _HEAD
    + "@UNPACK_SCHEMA@"
    + r"""if [ ! -s /run/yawmi/yawmi_api_pw ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /run/yawmi/yawmi_api_pw
  echo "yawmi-loader: generated yawmi_api_pw in yawmi_secrets"
fi
chown 10001:10001 /run/yawmi/yawmi_api_pw
chmod 0400 /run/yawmi/yawmi_api_pw
$PSQL -At <<'SQL'
CREATE SCHEMA IF NOT EXISTS yawmi;
CREATE TABLE IF NOT EXISTS yawmi.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
SELECT count(*) = 0 AS todo FROM yawmi.schema_migrations WHERE filename = '@SCHEMA@' \gset
\if :todo
BEGIN;
\i /tmp/0001.sql
INSERT INTO yawmi.schema_migrations (filename) VALUES ('@SCHEMA@') ON CONFLICT DO NOTHING;
COMMIT;
\echo yawmi-loader: applied @SCHEMA@
\else
\echo yawmi-loader: @SCHEMA@ already applied, skipped
\endif
SELECT 'yawmi-verify schema_tables=' || count(*) FROM information_schema.tables
 WHERE table_schema = 'yawmi' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations';
SELECT 'yawmi-verify migrations=' || string_agg(filename, ',' ORDER BY filename) FROM yawmi.schema_migrations;
SQL
stat -c 'yawmi-verify secret_bytes=%s mode=%a owner=%u' /run/yawmi/yawmi_api_pw
echo "yawmi-loader: schema step done"
"""
)

_NO_SEED_GUARD = r"""echo "yawmi-loader: api/db/seed/habits.sql is not embedded in this file: regenerate with deploy/tools/build_loaders.py once the seed exists"
exit 1
"""

# The seed is an upsert (ON CONFLICT (code) DO UPDATE that keeps anchor, reminders and start_day),
# so it runs every time: a changed seed is picked up by regenerating and re-running loader 2.
_SEED_STEP = r"""BEGIN;
\i /tmp/seed.sql
COMMIT;
\echo yawmi-loader: system habits upserted
"""

# The password reaches the database in exactly one statement: the ALTER ROLE below, run in a
# transaction that turns statement logging off for itself (log_statement, log_min_error_statement,
# log_min_duration_statement; all superuser-only, and raqib_admin is the bootstrap superuser).
# 0002 is therefore applied WITHOUT its optional yawmi_migrate.yawmi_api_pw setting, so it only
# creates the role and says so in a NOTICE; the ALTER ROLE, which runs on every execution, sets
# (or re-syncs) the password.
_LOADER_2 = (
    _HEAD.replace("#!/bin/sh\n", "#!/bin/sh\n@SEED_GUARD@", 1)
    + "@UNPACK_ROLE@@UNPACK_SEED@"
    + r"""[ -s /run/yawmi/yawmi_api_pw ] || { echo "yawmi-loader: yawmi_api_pw is missing: run loader 1 first"; exit 1; }
$PSQL -At <<'SQL'
DO $$
DECLARE miss text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM yawmi.schema_migrations WHERE filename = '@SCHEMA@') THEN
    RAISE EXCEPTION 'yawmi-loader: @SCHEMA@ is not applied: run loader 1 first';
  END IF;
  SELECT string_agg(r, ',') INTO miss FROM unnest(ARRAY['raqib.notion_milestones','raqib.notion_cards','raqib.goals','raqib.cycles','raqib.kpis','raqib.kpi_readings','raqib.v_journal_daily']) AS r WHERE to_regclass(r) IS NULL;
  IF miss IS NOT NULL THEN
    RAISE EXCEPTION 'yawmi-loader: raqib objects missing: % (apply the W9 tables loader first)', miss;
  END IF;
END $$;
SELECT count(*) = 0 AS todo FROM yawmi.schema_migrations WHERE filename = '@ROLE@' \gset
\if :todo
BEGIN;
\i /tmp/0002.sql
INSERT INTO yawmi.schema_migrations (filename) VALUES ('@ROLE@') ON CONFLICT DO NOTHING;
COMMIT;
\echo yawmi-loader: applied @ROLE@
\else
\echo yawmi-loader: @ROLE@ already applied, skipped
\endif
\set yawmi_api_pw `cat /run/yawmi/yawmi_api_pw`
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
SET LOCAL log_min_duration_statement = -1;
ALTER ROLE yawmi_api PASSWORD :'yawmi_api_pw';
COMMIT;
\unset yawmi_api_pw
\echo yawmi-loader: yawmi_api password synced
@SEED_STEP@SELECT 'yawmi-verify migrations=' || string_agg(filename, ',' ORDER BY filename) FROM yawmi.schema_migrations;
SELECT 'yawmi-verify system_habits=' || count(*) FROM yawmi.habits WHERE system;
SELECT 'yawmi-verify api_role=' || concat_ws(',', rolsuper, rolcreatedb, rolcreaterole, rolconnlimit, rolpassword IS NOT NULL) FROM pg_authid WHERE rolname = 'yawmi_api';
SQL
(
  PGUSER=yawmi_api
  PGPASSWORD="$(cat /run/yawmi/yawmi_api_pw)"
  export PGUSER PGPASSWORD
  $PSQL -At <<'SQL'
SELECT 'yawmi-verify api_login=' || current_user || ',search_path=' || current_setting('search_path');
SELECT 'yawmi-verify api_reads_habits=' || count(*) FROM yawmi.habits;
SELECT 'yawmi-verify api_reads_raqib_kpis=' || count(*) FROM raqib.kpis;
SELECT 'yawmi-verify api_reads_v_journal_daily=' || count(*) FROM raqib.v_journal_daily;
DO $$
DECLARE
  t text;
  denied int := 0;
  probes text[] := ARRAY['DELETE FROM yawmi.events WHERE false', 'SELECT 1 FROM yawmi.schema_migrations',
    'CREATE TABLE yawmi.api_probe (x int)', 'SELECT 1 FROM raqib.facts'];
BEGIN
  FOREACH t IN ARRAY probes LOOP
    BEGIN
      EXECUTE t;
      RAISE EXCEPTION 'yawmi-verify DENIED=NO: %', t;
    EXCEPTION WHEN insufficient_privilege THEN
      denied := denied + 1;
    END;
  END LOOP;
  RAISE NOTICE 'yawmi-verify denied_probes=%/%', denied, array_length(probes, 1);
END $$;
SQL
)
echo "yawmi-loader: role step done"
"""
)

# Loader 3 has loader 1's shape without the password step: unpack, check, apply one file and
# its ledger row in one transaction (the grants section of the file runs on every run, since re-applying
# loader 2 resets them), then verify read-only (as yawmi_api through SET ROLE, which
# the bootstrap superuser may do, so no password is involved).
_LOADER_3 = (
    _HEAD
    + "@UNPACK_WEB@"
    + r"""sed -n '/^REVOKE ALL ON SCHEMA yawmi_ro/,$p' /tmp/0003.sql > /tmp/grants.sql
[ -s /tmp/grants.sql ] || { echo "yawmi-loader: grants section not found in 0003"; exit 1; }
$PSQL -At <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM yawmi.schema_migrations WHERE filename = '@ROLE@') THEN
    RAISE EXCEPTION 'yawmi-loader: @ROLE@ is not applied: run loader 2 first';
  END IF;
  IF to_regclass('raqib.notion_cards') IS NULL THEN
    RAISE EXCEPTION 'yawmi-loader: raqib.notion_cards is missing (apply the W9 tables loader first)';
  END IF;
END $$;
SELECT count(*) = 0 AS todo FROM yawmi.schema_migrations WHERE filename = '@WEB@' \gset
\if :todo
BEGIN;
\i /tmp/0003.sql
INSERT INTO yawmi.schema_migrations (filename) VALUES ('@WEB@') ON CONFLICT DO NOTHING;
COMMIT;
\echo yawmi-loader: applied @WEB@
\else
\echo yawmi-loader: @WEB@ already applied, skipped
\endif
BEGIN;
\i /tmp/grants.sql
COMMIT;
\echo yawmi-loader: grants re-asserted
SELECT 'yawmi-verify migrations=' || string_agg(filename, ',' ORDER BY filename) FROM yawmi.schema_migrations;
SELECT 'yawmi-verify schema_tables=' || count(*) FROM information_schema.tables
 WHERE table_schema = 'yawmi' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations';
SET ROLE yawmi_api;
SELECT 'yawmi-verify api_reads_card_fields=' || count(*) FROM yawmi_ro.notion_card_fields;
SELECT 'yawmi-verify api_reads_goal_edits=' || count(*) FROM yawmi.goal_edits;
DO $$
DECLARE
  t text;
  denied int := 0;
  probes text[] := ARRAY['SELECT props FROM raqib.notion_cards', 'DELETE FROM yawmi.goal_edits WHERE false',
    'SELECT 1 FROM yawmi.schema_migrations'];
BEGIN
  FOREACH t IN ARRAY probes LOOP
    BEGIN
      EXECUTE t;
      RAISE EXCEPTION 'yawmi-verify DENIED=NO: %', t;
    EXCEPTION WHEN insufficient_privilege THEN
      denied := denied + 1;
    END;
  END LOOP;
  RAISE NOTICE 'yawmi-verify denied_probes=%/%', denied, array_length(probes, 1);
END $$;
RESET ROLE;
SQL
echo "yawmi-loader: web step done"
"""
)

_COMPOSE = """# Yawmi loader @STEP@: @WHAT@. One-shot, re-runnable.
# Generated by deploy/tools/build_loaders.py (SQL minified); do not edit by hand.
# Env: YAWMI_DB_HOST (required), YAWMI_DB_NAME (raqib), RAQIB_NETWORK (raqib_internal).
# External volume yawmi_secrets: create it first (RUNBOOK step 3).
name: yawmi-loader
services:
  yawmi-loader:
    image: postgres:16-alpine
    entrypoint: ["/bin/sh", "/yawmi/load.sh"]
    restart: "no"
    environment:
      PGHOST: ${YAWMI_DB_HOST:?YAWMI_DB_HOST is required}
      PGDATABASE: ${YAWMI_DB_NAME:-raqib}
      PGUSER: raqib_admin
    networks:
      - raqib
    volumes:
      - raqib_secrets:/run/raqib:ro
      - yawmi_secrets:/run/yawmi@SECRETS_MODE@
    configs:
      - source: load
        target: /yawmi/load.sh
@CONFIG_SOURCES@configs:
  load:
    content: |
@SCRIPT@
@BLOBS@volumes:
  raqib_secrets:
    name: raqib_secrets
    external: true
  yawmi_secrets:
    name: yawmi_secrets
    external: true
networks:
  raqib:
    name: ${RAQIB_NETWORK:-raqib_internal}
    external: true
"""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def minify_sql(text: str, label: str = "sql") -> str:
    """Drop blank and `--` comment-only lines; refuse input where that could change meaning.

    Refused: `/* */` comments, and a comment-looking line inside an unterminated single-quoted
    string (so a string literal can never lose a line).
    """
    if "/*" in text:
        raise ValueError(f"{label}: block comments are not supported by the minifier")
    kept: list[str] = []
    open_quote = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("--") and open_quote:
            raise ValueError(f"{label}: a `--` line inside a string literal cannot be minified")
        if not stripped or stripped.startswith("--"):
            continue
        if line.count("'") % 2:
            open_quote = not open_quote
        kept.append(line)
    return "\n".join(kept) + "\n"


def _blob(data: bytes) -> str:
    """gzip (mtime 0, so the same input gives the same bytes) then base64 in 100-column lines."""
    packed = base64.b64encode(gzip.compress(data, 9, mtime=0)).decode("ascii")
    return "\n".join(textwrap.wrap(packed, 100))


def _indent(text: str, spaces: int) -> str:
    pad = " " * spaces
    return "\n".join(pad + line if line else line for line in text.rstrip("\n").split("\n"))


def _compose_escape(script: str) -> str:
    return script.replace("$", "$$")


def _fill(template: str, **values: str) -> str:
    """Replace every `@KEY@` in `template`; a key left over is a bug, so it raises."""
    for key, value in values.items():
        template = template.replace(f"@{key}@", value)
    leftover = re.search(r"@[A-Z_]+@", template)
    if leftover:
        raise ValueError(f"placeholder not filled: {leftover.group()}")
    return template


def _unpack(key: str, packed: bytes) -> str:
    return _fill(_UNPACK, KEY=key, SHA=sha256(packed))


def _payload(key: str, packed: bytes) -> tuple[str, str]:
    """`(config source line for the service, config definition)` for one packed SQL file."""
    source = f"      - source: p{key}\n        target: /yawmi/in/{key}.b64\n"
    return source, f"  p{key}:\n    content: |\n{_indent(_blob(packed), 6)}\n"


def _render(step: str, what: str, script: str, keys: dict[str, bytes], *, loader_1: bool) -> str:
    sources = ""
    blobs = ""
    for key, packed in keys.items():
        source, blob = _payload(key, packed)
        sources += source
        blobs += blob
    return _fill(
        _COMPOSE,
        STEP=step,
        WHAT=what,
        SECRETS_MODE="" if loader_1 else ":ro",
        CONFIG_SOURCES=sources,
        SCRIPT=_indent(_compose_escape(script), 6),
        BLOBS=blobs,
    )


def render_loader_1(schema: bytes) -> str:
    """`schema` is the minified 0001 text."""
    script = _fill(_LOADER_1, UNPACK_SCHEMA=_unpack("0001", schema), SCHEMA=SCHEMA_FILE)
    return _render(
        "1/2",
        "applies the yawmi schema (0001) and generates the API password secret",
        script,
        {"0001": schema},
        loader_1=True,
    )


def render_loader_3(web: bytes) -> str:
    """`web` is the minified 0003 text."""
    script = _fill(_LOADER_3, UNPACK_WEB=_unpack("0003", web), ROLE=ROLE_FILE, WEB=WEB_FILE)
    return _render(
        "3/3",
        "applies the desktop web schema (0003) and verifies it as yawmi_api",
        script,
        {"0003": web},
        loader_1=False,
    )


def render_loader_2(role: bytes, seed: bytes | None) -> str:
    """`role` and `seed` are the minified 0002 and habits.sql texts (`seed` may be absent)."""
    keys = {"0002": role}
    if seed is None:
        guard, unpack_seed, seed_step = _NO_SEED_GUARD, "", ""
    else:
        keys["seed"] = seed
        guard, unpack_seed, seed_step = "", _unpack("seed", seed), _SEED_STEP
    script = _fill(
        _LOADER_2,
        SEED_GUARD=guard,
        UNPACK_ROLE=_unpack("0002", role),
        UNPACK_SEED=unpack_seed,
        SEED_STEP=seed_step,
        SCHEMA=SCHEMA_FILE,
        ROLE=ROLE_FILE,
    )
    return _render(
        "2/2",
        "applies the yawmi_api role (0002), seeds the system habits, verifies as yawmi_api",
        script,
        keys,
        loader_1=False,
    )


_DECLARED = re.compile(r"printf '%s  %s\\n' (?P<sha>[0-9a-f]{64}) /tmp/(?P<key>\w+)\.sql \|")
_BLOB = re.compile(
    r"^  p(?P<key>\w+):\n    content: \|\n(?P<body>(?:      [A-Za-z0-9+/=]+\n?)+)", re.MULTILINE
)


def embedded_hashes(compose_text: str) -> dict[str, tuple[str, str]]:
    """`{payload key: (sha256 the script demands, sha256 of the text the blob really holds)}`.

    Equal members mean the loader will accept its own payload; the first member compared with
    `sha256(minify_sql(source))` tells whether the compose file is stale.
    """
    declared = {m["key"]: m["sha"] for m in _DECLARED.finditer(compose_text)}
    result: dict[str, tuple[str, str]] = {}
    for match in _BLOB.finditer(compose_text):
        key = match["key"]
        if key in declared:
            raw = base64.b64decode("".join(match["body"].split()))
            result[key] = (declared[key], sha256(gzip.decompress(raw)))
    return result


def _normalized(compose_text: str) -> str:
    """The file with each packed payload replaced by the sha256 of the SQL it unpacks to.

    Everything else (scripts, compose keys, header comments) is kept verbatim. Packed bytes are
    the one thing compared by meaning instead: gzip output may differ between zlib builds while
    the SQL the loader runs cannot.
    """

    def unpacked(match: re.Match[str]) -> str:
        raw = base64.b64decode("".join(match["body"].split()))
        digest = sha256(gzip.decompress(raw))
        return f"  p{match['key']}:\n    content: |\n      sha256:{digest}\n"

    return _BLOB.sub(unpacked, compose_text)


def is_current(committed: str, fresh: str) -> bool:
    """True when `committed` is what `fresh` (a new render) says it should be.

    The full text must match, payloads aside (`_normalized`), and each payload must be a gzip of
    exactly the SQL whose hash its own script demands. A hand edit of a committed loader, a change
    to a script or compose template, a changed SQL source or a damaged payload all return False.
    """
    try:
        own = embedded_hashes(committed)
        return all(a == b for a, b in own.values()) and _normalized(committed) == _normalized(fresh)
    except (ValueError, OSError, EOFError, zlib.error):  # bad base64 or gzip
        return False


def _read(path: Path) -> str:
    if not path.is_file():
        raise SystemExit(f"المصدر غير موجود: {path.name}")
    text = path.read_bytes().decode("utf-8")
    if "\r" in text:
        raise SystemExit(f"{path.name} فيه \\r: المطلوب LF فقط")
    return text


def sources_to_payloads(migrations: Path, seed_path: Path) -> dict[str, bytes | None]:
    """Minified, UTF-8 payloads by key: `0001`, `0002`, `0003`, and `seed` (None while missing)."""
    return {
        "0001": minify_sql(_read(migrations / SCHEMA_FILE), SCHEMA_FILE).encode(),
        "0002": minify_sql(_read(migrations / ROLE_FILE), ROLE_FILE).encode(),
        "0003": minify_sql(_read(migrations / WEB_FILE), WEB_FILE).encode(),
        "seed": minify_sql(_read(seed_path), seed_path.name).encode()
        if seed_path.is_file()
        else None,
    }


def build(migrations: Path, seed_path: Path) -> dict[str, str]:
    payloads = sources_to_payloads(migrations, seed_path)
    schema, role = payloads["0001"], payloads["0002"]
    web = payloads["0003"]
    assert schema is not None and role is not None and web is not None
    return {
        LOADER_1: render_loader_1(schema),
        LOADER_2: render_loader_2(role, payloads["seed"]),
        LOADER_3: render_loader_3(web),
    }


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--migrations-dir", type=Path, default=DEFAULT_MIGRATIONS)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--check", action="store_true", help="لا يكتب: يفشل إن اختلفت البصمات")
    args = parser.parse_args(argv)

    files = build(args.migrations_dir, args.seed)
    status = 0
    for name, text in files.items():
        if len(text) > MAX_CHARS:
            print(f"{name}: {len(text)} حرفاً، فوق الحد {MAX_CHARS}")
            status = 1
            continue
        target = args.out / name
        if args.check:
            # bytes, not read_text(): a CRLF copy must not be quietly normalised into a match
            committed = target.read_bytes().decode("utf-8", "replace") if target.is_file() else ""
            ok = is_current(committed, text)
            print(f"{name}: {'مطابق' if ok else 'قديم أو معدَّل يدوياً: أعد التوليد'}")
            status |= 0 if ok else 1
        else:
            args.out.mkdir(parents=True, exist_ok=True)
            target.write_bytes(text.encode("utf-8"))
            print(f"{name}: {len(text)} حرفاً")
    return status


if __name__ == "__main__":
    sys.exit(main())
