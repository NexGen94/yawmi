"""`yawmi-admin` and the asyncpg-backed `DeviceStore`: the SQL-free parts only.

The SQL itself is NOT exercised here (no Postgres locally): these tests cover code generation,
the CLI parser, row mapping, command-tag parsing and the wiring between store methods and the
pool. The statements are checked against a real database only once the schema (task 3) is loaded.
"""

import argparse
from datetime import UTC, datetime, timedelta
from typing import Any, Self
from uuid import uuid4

import pytest

from yawmi import admin
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.pg_store import AsyncpgDeviceStore, affected_rows, device_from_row
from yawmi.auth.tokens import AuthError, verify_access
from yawmi.settings import Settings

NOW = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)


# --- admin: code generation --------------------------------------------------------------------


def test_generate_code_is_eight_digits() -> None:
    for _ in range(50):
        code = admin.generate_code()
        assert len(code) == 8
        assert code.isascii()
        assert code.isdigit()


def test_generate_code_keeps_leading_zeros(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(admin.secrets, "randbelow", lambda _n: 5)
    assert admin.generate_code() == "00000005"


async def test_issue_pairing_code_is_valid_for_ten_minutes() -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    code = await admin.issue_pairing_code(store, "watch", now=NOW)
    assert admin.CODE_TTL == timedelta(minutes=10)

    # still valid just before the ten minutes are over, and bound to the requested kind
    store.clock = lambda: NOW + timedelta(minutes=9, seconds=59)
    consumed = await store.consume_pairing_code(code)
    assert consumed is not None
    assert consumed.kind == "watch"
    assert consumed.expires_at == NOW + timedelta(minutes=10)


async def test_issued_pairing_code_expires_after_ten_minutes() -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    code = await admin.issue_pairing_code(store, "iphone", now=NOW)
    store.clock = lambda: NOW + timedelta(minutes=10, seconds=1)
    assert await store.consume_pairing_code(code) is None


async def test_issue_pairing_code_retries_on_collision(monkeypatch: pytest.MonkeyPatch) -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    assert await store.add_pairing_code("11111111", "iphone", NOW + timedelta(minutes=5))
    draws = iter(["11111111", "11111111", "22222222"])
    monkeypatch.setattr(admin, "generate_code", lambda: next(draws))
    assert await admin.issue_pairing_code(store, "web", now=NOW) == "22222222"


async def test_issue_pairing_code_gives_up_after_too_many_collisions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    assert await store.add_pairing_code("11111111", "iphone", NOW + timedelta(minutes=5))
    monkeypatch.setattr(admin, "generate_code", lambda: "11111111")
    with pytest.raises(RuntimeError):
        await admin.issue_pairing_code(store, "web", now=NOW)


async def test_issue_pairing_code_rejects_service_kind() -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    with pytest.raises(ValueError):
        await admin.issue_pairing_code(store, "service", now=NOW)


# --- admin: CLI --------------------------------------------------------------------------------


def test_parser_accepts_the_three_pairable_kinds() -> None:
    parser = admin.build_parser()
    for kind in ("iphone", "watch", "web"):
        args = parser.parse_args(["pair-code", "--kind", kind])
        assert args.command == "pair-code"
        assert args.kind == kind


@pytest.mark.parametrize(
    "argv",
    [["pair-code", "--kind", "service"], ["pair-code", "--kind", "toaster"], ["pair-code"], []],
)
def test_parser_rejects_bad_arguments(argv: list[str]) -> None:
    parser = admin.build_parser()
    with pytest.raises(SystemExit) as exc:
        parser.parse_args(argv)
    assert exc.value.code == 2


def test_parser_is_an_argparse_parser() -> None:
    assert isinstance(admin.build_parser(), argparse.ArgumentParser)


# --- pg store: row mapping and command tags ----------------------------------------------------


def test_device_from_row_maps_all_columns() -> None:
    device_id = uuid4()
    row = {
        "id": device_id,
        "name": "ساعة",
        "kind": "watch",
        "refresh_hash": "ab" * 32,
        "paired_at": NOW,
        "revoked_at": None,
    }
    device = device_from_row(row)
    assert device.id == device_id
    assert device.name == "ساعة"
    assert device.kind == "watch"
    assert device.refresh_hash == "ab" * 32
    assert device.paired_at == NOW
    assert device.revoked_at is None


@pytest.mark.parametrize(
    ("tag", "count"),
    [("UPDATE 1", 1), ("UPDATE 0", 0), ("INSERT 0 1", 1), ("INSERT 0 0", 0), ("DELETE 3", 3)],
)
def test_affected_rows_parses_command_tags(tag: str, count: int) -> None:
    assert affected_rows(tag) == count


# --- pg store: wiring to the pool (SQL text is not validated) ----------------------------------


class FakePool:
    """Records calls and answers with canned values; stands in for `asyncpg.Pool`."""

    def __init__(self, *, execute: str = "UPDATE 1", fetchrow: dict[str, Any] | None = None):
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []
        self._execute = execute
        self._fetchrow = fetchrow

    async def execute(self, sql: str, *args: Any) -> str:
        self.calls.append(("execute", sql, args))
        return self._execute

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        self.calls.append(("fetchrow", sql, args))
        return self._fetchrow

    def acquire(self) -> "FakePool":
        """`async with pool.acquire() as conn`: the fake is its own connection."""
        return self

    def transaction(self) -> "FakePool":
        return self

    async def __aenter__(self) -> Self:
        self.calls.append(("begin", "", ()))
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.calls.append(("end", "", ()))


async def test_pg_rotate_refresh_reports_whether_a_row_changed() -> None:
    device_id = uuid4()
    hit = FakePool(execute="UPDATE 1")
    ttl = timedelta(days=90)
    assert (
        await AsyncpgDeviceStore(hit).rotate_refresh(device_id, "old", "new", max_age=ttl) is True
    )  # type: ignore[arg-type]
    assert hit.calls[0][2] == (device_id, "old", "new", ttl)
    assert "refresh_rotated_at > now() - $4::interval" in hit.calls[0][1]
    assert "refresh_rotated_at = now()" in hit.calls[0][1]
    miss = FakePool(execute="UPDATE 0")
    assert (
        await AsyncpgDeviceStore(miss).rotate_refresh(device_id, "old", "new", max_age=ttl) is False
    )  # type: ignore[arg-type]


async def test_pg_revoke_reports_whether_the_device_exists() -> None:
    device_id = uuid4()
    assert await AsyncpgDeviceStore(FakePool(execute="UPDATE 1")).revoke(device_id) is True  # type: ignore[arg-type]
    assert await AsyncpgDeviceStore(FakePool(execute="UPDATE 0")).revoke(device_id) is False  # type: ignore[arg-type]


async def test_pg_revoke_deletes_the_devices_push_subscriptions_in_the_same_transaction() -> None:
    device_id = uuid4()
    pool = FakePool(execute="UPDATE 1")
    await AsyncpgDeviceStore(pool).revoke(device_id)  # type: ignore[arg-type]
    kinds = [c[0] for c in pool.calls]
    assert kinds[0] == "begin" and kinds[-1] == "end"
    statements = [c for c in pool.calls if c[0] == "execute"]
    assert "UPDATE yawmi.devices" in statements[0][1]
    assert "DELETE FROM yawmi.push_subscriptions WHERE device_id = $1" in statements[1][1]
    assert statements[1][2] == (device_id,)


async def test_pg_get_device_returns_none_when_missing_or_a_device_when_found() -> None:
    device_id = uuid4()
    assert await AsyncpgDeviceStore(FakePool(fetchrow=None)).get_device(device_id) is None  # type: ignore[arg-type]
    row = {
        "id": device_id,
        "name": "x",
        "kind": "web",
        "refresh_hash": None,
        "paired_at": NOW,
        "revoked_at": NOW,
    }
    device = await AsyncpgDeviceStore(FakePool(fetchrow=row)).get_device(device_id)  # type: ignore[arg-type]
    assert device is not None
    assert device.revoked_at == NOW


async def test_pg_consume_pairing_code_maps_row_or_none() -> None:
    assert await AsyncpgDeviceStore(FakePool(fetchrow=None)).consume_pairing_code("1") is None  # type: ignore[arg-type]
    row = {"code": "12345678", "kind": "iphone", "expires_at": NOW}
    pool = FakePool(fetchrow=row)
    consumed = await AsyncpgDeviceStore(pool).consume_pairing_code("12345678")  # type: ignore[arg-type]
    assert consumed is not None
    assert (consumed.code, consumed.kind, consumed.expires_at) == ("12345678", "iphone", NOW)
    assert pool.calls[0][2] == ("12345678",)


async def test_pg_add_pairing_code_reports_whether_it_was_inserted() -> None:
    assert await AsyncpgDeviceStore(FakePool(execute="INSERT 0 1")).add_pairing_code(  # type: ignore[arg-type]
        "1", "web", NOW
    )
    assert not await AsyncpgDeviceStore(FakePool(execute="INSERT 0 0")).add_pairing_code(  # type: ignore[arg-type]
        "1", "web", NOW
    )


# --- admin: service-token ----------------------------------------------------------------------

SECRET = "t" * 40


async def test_issue_service_token_creates_a_service_device_and_signs_for_it() -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    token = await admin.issue_service_token(store, "n8n", secret=SECRET, ttl_hours=2)

    claims = verify_access(token, SECRET)
    assert claims.kind == "service"
    device = await store.get_device(claims.sub)
    assert device is not None
    assert (device.name, device.kind, device.revoked_at) == ("n8n", "service", None)
    remaining = claims.exp - datetime.now(UTC)
    assert timedelta(hours=1, minutes=59) < remaining <= timedelta(hours=2)


async def test_service_token_carries_no_usable_refresh_token() -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    token = await admin.issue_service_token(store, "n8n", secret=SECRET, ttl_hours=1)
    device_id = verify_access(token, SECRET).sub
    # nobody holds the raw refresh token, so no hash a client can present will ever rotate it
    for guess in ("", "x", "0" * 64):
        assert (
            await store.rotate_refresh(device_id, guess, "new", max_age=timedelta(days=90)) is False
        )


async def test_service_token_is_signed_with_the_given_secret_only() -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    token = await admin.issue_service_token(store, "n8n", secret=SECRET, ttl_hours=1)
    with pytest.raises(AuthError):
        verify_access(token, "u" * 40)


async def test_two_service_tokens_are_two_devices() -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    first = await admin.issue_service_token(store, "a", secret=SECRET, ttl_hours=1)
    second = await admin.issue_service_token(store, "b", secret=SECRET, ttl_hours=1)
    assert verify_access(first, SECRET).sub != verify_access(second, SECRET).sub


@pytest.mark.parametrize("name", ["", "   ", "x" * 101])
async def test_issue_service_token_rejects_a_bad_name(name: str) -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    with pytest.raises(ValueError):
        await admin.issue_service_token(store, name, secret=SECRET, ttl_hours=1)


@pytest.mark.parametrize("hours", [0, -1, admin.MAX_SERVICE_TTL_HOURS + 1])
async def test_issue_service_token_rejects_a_bad_ttl(hours: int) -> None:
    store = InMemoryDeviceStore(clock=lambda: NOW)
    with pytest.raises(ValueError):
        await admin.issue_service_token(store, "n8n", secret=SECRET, ttl_hours=hours)


def test_parser_service_token_defaults_to_one_year() -> None:
    args = admin.build_parser().parse_args(["service-token", "--name", "n8n"])
    assert args.command == "service-token"
    assert args.name == "n8n"
    assert args.ttl_hours == 8760
    assert args.dry_run is False


def test_parser_service_token_accepts_ttl_and_dry_run() -> None:
    args = admin.build_parser().parse_args(
        ["service-token", "--name", "n8n", "--ttl-hours", "24", "--dry-run"]
    )
    assert (args.ttl_hours, args.dry_run) == (24, True)


@pytest.mark.parametrize(
    "argv",
    [
        ["service-token"],
        ["service-token", "--name", "n8n", "--ttl-hours", "0"],
        ["service-token", "--name", "n8n", "--ttl-hours", "abc"],
        ["service-token", "--name", "n8n", "--ttl-hours", str(admin.MAX_SERVICE_TTL_HOURS + 1)],
    ],
)
def test_parser_service_token_rejects_bad_arguments(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        admin.build_parser().parse_args(argv)
    assert exc.value.code == 2


def _settings() -> Settings:
    return Settings(database_url="postgresql:///none", jwt_secret=SECRET)  # type: ignore[arg-type]


def test_main_service_token_dry_run_prints_exactly_one_line_with_the_token(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(admin, "settings", _settings)
    assert admin.main(["service-token", "--name", "n8n", "--dry-run"]) == 0
    out, err = capsys.readouterr()
    lines = out.splitlines()
    assert len(lines) == 1
    assert verify_access(lines[0], SECRET).kind == "service"
    assert "تجريبي" in err
    assert SECRET not in out + err


class ClosablePool(FakePool):
    def __init__(self) -> None:
        super().__init__(execute="INSERT 0 1")
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def test_main_service_token_writes_one_service_device_row(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pool = ClosablePool()

    async def fake_create_pool(dsn: str, **_: Any) -> ClosablePool:
        return pool

    monkeypatch.setattr(admin, "settings", _settings)
    monkeypatch.setattr(admin, "create_pool", fake_create_pool)
    assert admin.main(["service-token", "--name", "n8n", "--ttl-hours", "5"]) == 0

    inserts = [call for call in pool.calls if "yawmi.devices" in call[1]]
    assert len(inserts) == 1
    device_id, name, kind, refresh_hash = inserts[0][2]
    assert (name, kind) == ("n8n", "service")
    assert len(refresh_hash) == 64  # a SHA-256 hex digest of a token nobody ever saw
    token = capsys.readouterr().out.strip()
    assert verify_access(token, SECRET).sub == device_id
    assert pool.closed


def test_main_service_token_failure_names_only_the_exception_class(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def boom(dsn: str, **_: Any) -> None:
        raise ConnectionRefusedError("detail-that-must-not-leak")

    monkeypatch.setattr(admin, "settings", _settings)
    monkeypatch.setattr(admin, "create_pool", boom)
    assert admin.main(["service-token", "--name", "n8n"]) == 1
    out, err = capsys.readouterr()
    assert out == ""
    assert "ConnectionRefusedError" in err
    assert "detail-that-must-not-leak" not in err
