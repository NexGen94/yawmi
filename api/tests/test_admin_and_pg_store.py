"""`yawmi-admin` and the asyncpg-backed `DeviceStore`: the SQL-free parts only.

The SQL itself is NOT exercised here (no Postgres locally): these tests cover code generation,
the CLI parser, row mapping, command-tag parsing and the wiring between store methods and the
pool. The statements are checked against a real database only once the schema (task 3) is loaded.
"""

import argparse
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest

from yawmi import admin
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.pg_store import AsyncpgDeviceStore, affected_rows, device_from_row

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


async def test_pg_rotate_refresh_reports_whether_a_row_changed() -> None:
    device_id = uuid4()
    hit = FakePool(execute="UPDATE 1")
    assert await AsyncpgDeviceStore(hit).rotate_refresh(device_id, "old", "new") is True  # type: ignore[arg-type]
    assert hit.calls[0][2] == (device_id, "old", "new")
    miss = FakePool(execute="UPDATE 0")
    assert await AsyncpgDeviceStore(miss).rotate_refresh(device_id, "old", "new") is False  # type: ignore[arg-type]


async def test_pg_revoke_reports_whether_the_device_exists() -> None:
    device_id = uuid4()
    assert await AsyncpgDeviceStore(FakePool(execute="UPDATE 1")).revoke(device_id) is True  # type: ignore[arg-type]
    assert await AsyncpgDeviceStore(FakePool(execute="UPDATE 0")).revoke(device_id) is False  # type: ignore[arg-type]


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
