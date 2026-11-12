"""`/v1/events` end to end: idempotent batches, back-dated habit logs, pull by cursor.

Every API test runs twice through the `backend` fixture: against the in-memory store (always)
and against Postgres (when `TEST_DATABASE_URL` points at a database with the `yawmi` schema
loaded; skipped otherwise, never silently passed). The assertions are identical, so the
in-memory store is checked against the SQL it stands in for.
"""

import asyncio
import itertools
import json
import logging
import os
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol, cast
from uuid import UUID, uuid4

import asyncpg
import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.db.pool import create_pool, set_pool
from yawmi.domain.habits import HabitLog as HabitLogRule
from yawmi.domain.habits import HabitSpec, period_progress
from yawmi.events.memory_store import InMemoryEventStore
from yawmi.events.models import EventIn, StoredEvent
from yawmi.events.project import BreathSession, FocusSession, HabitLog, plan
from yawmi.events.store import (
    _INSERT_BREATH,
    _INSERT_FOCUS,
    _UPSERT_HABIT_LOG,
    AsyncpgEventStore,
    EventStore,
    InvalidPayloads,
    breath_args,
    focus_args,
    habit_log_args,
    next_received_base,
    received_times,
)
from yawmi.main import create_app
from yawmi.settings import Settings
from yawmi.today.reader import AsyncpgTodayReader
from yawmi.today.reader import LogRow as ReaderLogRow

SECRET = "test-secret-for-unit-tests-only-0123456789"
TTL = 900
UNAUTHORIZED = {"detail": "غير مصرّح"}
FORBIDDEN = {"detail": "غير مسموح"}
INVALID = "طلب غير صالح"

NOON = "2026-11-10T09:00:00Z"  # 12:00 in Riyadh on 2026-11-10
# the habit `new_habit` makes: a daily count with target 1 from 2026-01-01
COUNT_DAILY = HabitSpec(
    "count", None, 1.0, "day", "every_day", None, None, None, date(2026, 1, 1), None
)


def make_settings() -> Settings:
    return Settings(
        database_url="postgresql://yawmi_api@localhost:5432/raqib",
        jwt_secret=SecretStr(SECRET),
    )


# --- backends: the same assertions against memory and Postgres --------------------------------


@dataclass
class LogRow:
    status: str | None
    value: Decimal | None
    event_id: UUID | None
    logged_at: datetime
    source: str


class Backend(Protocol):
    store: InMemoryEventStore | None

    async def new_device(self, kind: str) -> UUID: ...
    async def new_habit(self) -> str: ...
    async def new_goal_task(self) -> UUID: ...
    async def goal_task_done(
        self, task_id: UUID
    ) -> tuple[datetime | None, datetime | None] | None: ...
    async def habit_log(self, code: str, day: date) -> LogRow | None: ...
    async def habit_log_count(self, code: str) -> int: ...
    async def reader_logs(self, code: str) -> list[ReaderLogRow]: ...
    async def event_count(self, ids: list[UUID]) -> int: ...
    async def focus_rows(self, ids: list[UUID]) -> list[dict[str, Any]]: ...
    async def breath_rows(self, ids: list[UUID]) -> list[dict[str, Any]]: ...
    async def seed_events(self, count: int, received_at: datetime) -> list[UUID]: ...
    def make_store(self, clock: Callable[[], datetime] | None = None) -> EventStore: ...


class MemoryBackend:
    def __init__(self) -> None:
        self.store: InMemoryEventStore | None = InMemoryEventStore()

    def make_store(self, clock: Callable[[], datetime] | None = None) -> EventStore:
        """A fresh store (optionally on a fixed clock); the inspectors then read this one."""
        self.store = InMemoryEventStore() if clock is None else InMemoryEventStore(clock=clock)
        return self.store

    async def new_device(self, kind: str) -> UUID:
        return uuid4()

    async def new_habit(self) -> str:
        assert self.store is not None
        code = f"t07-{uuid4().hex[:8]}"
        self.store.habits.add(code)
        return code

    async def new_goal_task(self) -> UUID:
        assert self.store is not None
        task_id = uuid4()
        self.store.goal_tasks[task_id] = (None, None)
        return task_id

    async def goal_task_done(self, task_id: UUID) -> tuple[datetime | None, datetime | None] | None:
        assert self.store is not None
        return self.store.goal_tasks.get(task_id)

    async def habit_log(self, code: str, day: date) -> LogRow | None:
        assert self.store is not None
        row = self.store.habit_logs.get((code, day))
        if row is None:
            return None
        return LogRow(row.status, row.value, row.event_id, row.logged_at, row.source)

    async def habit_log_count(self, code: str) -> int:
        assert self.store is not None
        return sum(1 for key in self.store.habit_logs if key[0] == code)

    async def reader_logs(self, code: str) -> list[ReaderLogRow]:
        assert self.store is not None
        return [
            ReaderLogRow(log.habit_code, log.day, log.value, log.status)
            for log in self.store.habit_logs.values()
            if log.habit_code == code
        ]

    async def event_count(self, ids: list[UUID]) -> int:
        assert self.store is not None
        return sum(1 for i in ids if i in self.store.events)

    async def focus_rows(self, ids: list[UUID]) -> list[dict[str, Any]]:
        assert self.store is not None
        return [asdict(s) for s in self.store.focus_sessions if s.event_id in ids]

    async def breath_rows(self, ids: list[UUID]) -> list[dict[str, Any]]:
        assert self.store is not None
        return [asdict(s) for s in self.store.breath_sessions if s.event_id in ids]

    async def seed_events(self, count: int, received_at: datetime) -> list[UUID]:
        assert self.store is not None
        ids = sorted(uuid4() for _ in range(count))
        for event_id in ids:
            self.store.events[event_id] = StoredEvent(
                id=event_id,
                device_id=None,
                type="app_opened",
                payload={},
                occurred_at=received_at,
                tz="Asia/Riyadh",
                received_at=received_at,
            )
        return ids


class PostgresBackend:
    store = None  # the route builds `AsyncpgEventStore` over the pool set by the fixture

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.devices: list[UUID] = []
        self.habits: list[str] = []
        self.goal_tasks: list[UUID] = []
        self.seeded: list[UUID] = []

    def make_store(self, clock: Callable[[], datetime] | None = None) -> EventStore:
        return (
            AsyncpgEventStore(self.pool)
            if clock is None
            else AsyncpgEventStore(self.pool, clock=clock)
        )

    async def new_device(self, kind: str) -> UUID:
        device_id = uuid4()
        await self.pool.execute(
            "INSERT INTO yawmi.devices (id, name, kind, paired_at) VALUES ($1, $2, $3, now())",
            device_id,
            "t07 test device",
            kind,
        )
        self.devices.append(device_id)
        return device_id

    async def new_habit(self) -> str:
        code = f"t07-{uuid4().hex[:8]}"
        await self.pool.execute(
            "INSERT INTO yawmi.habits (code, title_ar, kind, target_per_period, period, start_day,"
            " created_by) VALUES ($1, $2, 'count', 1, 'day', date '2026-01-01', 'user')",
            code,
            "عادة اختبار",
        )
        self.habits.append(code)
        return code

    async def new_goal_task(self) -> UUID:
        task_id = uuid4()
        await self.pool.execute(
            "INSERT INTO yawmi.goal_tasks (id, goal_ref, title) VALUES ($1, 'O7', 'مهمة اختبار')",
            task_id,
        )
        self.goal_tasks.append(task_id)
        return task_id

    async def goal_task_done(self, task_id: UUID) -> tuple[datetime | None, datetime | None] | None:
        row = await self.pool.fetchrow(
            "SELECT done_at, done_logged_at FROM yawmi.goal_tasks WHERE id = $1", task_id
        )
        return None if row is None else (row["done_at"], row["done_logged_at"])

    async def habit_log(self, code: str, day: date) -> LogRow | None:
        row = await self.pool.fetchrow(
            "SELECT status, value, event_id, logged_at, source FROM yawmi.habit_logs"
            " WHERE habit_code = $1 AND day = $2",
            code,
            day,
        )
        return None if row is None else LogRow(**dict(row))

    async def habit_log_count(self, code: str) -> int:
        return await self.pool.fetchval(
            "SELECT count(*) FROM yawmi.habit_logs WHERE habit_code = $1", code
        )

    async def reader_logs(self, code: str) -> list[ReaderLogRow]:
        """The rows the today, overview and progress readers get (their own SQL)."""
        return await AsyncpgTodayReader(self.pool).habit_logs_of(
            [code], date(2026, 1, 1), date(2026, 12, 31)
        )

    async def event_count(self, ids: list[UUID]) -> int:
        return await self.pool.fetchval("SELECT count(*) FROM yawmi.events WHERE id = ANY($1)", ids)

    async def focus_rows(self, ids: list[UUID]) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM yawmi.focus_sessions WHERE event_id = ANY($1)", ids
        )
        return [dict(r) for r in rows]

    async def breath_rows(self, ids: list[UUID]) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            "SELECT * FROM yawmi.breath_sessions WHERE event_id = ANY($1)", ids
        )
        return [dict(r) for r in rows]

    async def seed_events(self, count: int, received_at: datetime) -> list[UUID]:
        ids = sorted(uuid4() for _ in range(count))
        await self.pool.execute(
            "INSERT INTO yawmi.events (id, type, payload, occurred_at, received_at)"
            " SELECT unnest($1::uuid[]), 'app_opened', '{}'::jsonb, $2, $2",
            ids,
            received_at,
        )
        self.seeded += ids
        return ids

    async def cleanup(self) -> None:
        mine = await self.pool.fetch(
            "SELECT id FROM yawmi.events WHERE device_id = ANY($1)", self.devices
        )
        ids = [r["id"] for r in mine] + self.seeded
        for table in (
            "habit_logs",
            "focus_sessions",
            "breath_sessions",
            "journal_entries",
            "mood_logs",
        ):
            await self.pool.execute(f"DELETE FROM yawmi.{table} WHERE event_id = ANY($1)", ids)
        await self.pool.execute("DELETE FROM yawmi.events WHERE id = ANY($1)", ids)
        await self.pool.execute(
            "DELETE FROM yawmi.habit_logs WHERE habit_code = ANY($1)", self.habits
        )
        await self.pool.execute(
            "DELETE FROM yawmi.focus_sessions WHERE habit_code = ANY($1)", self.habits
        )
        await self.pool.execute("DELETE FROM yawmi.habits WHERE code = ANY($1)", self.habits)
        await self.pool.execute("DELETE FROM yawmi.goal_tasks WHERE id = ANY($1)", self.goal_tasks)
        await self.pool.execute("DELETE FROM yawmi.devices WHERE id = ANY($1)", self.devices)


IN_CI = bool(os.environ.get("CI"))
MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"
SCHEMA_SQL = MIGRATIONS / "0001_yawmi_schema.sql"
STUB_SQL = Path(__file__).parent / "fixtures" / "raqib_stub.sql"


async def ensure_schema(pool: asyncpg.Pool) -> None:
    """Make sure the `yawmi` schema exists: a fresh CI database starts without it.

    The migration tests drop and rebuild the schema around themselves, so nothing else loads it
    for these tests. The file is the one the migration runner applies (task 3), used as is.
    """
    await pool.execute(STUB_SQL.read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.events') IS NOT NULL"):
        if not SCHEMA_SQL.is_file():
            await pool.close()
            pytest.fail(f"the yawmi schema is not loaded and {SCHEMA_SQL} does not exist (task 3)")
        await pool.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.journal_entries') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0002_yawmi_role.sql").read_text(encoding="utf-8"))
        await pool.execute((MIGRATIONS / "0003_yawmi_web.sql").read_text(encoding="utf-8"))


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    if request.param == "memory":
        yield MemoryBackend()
        return
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:  # the project's convention: under CI the database tests fail, never skip
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await ensure_schema(pool)
    pg = PostgresBackend(pool)
    set_pool(pool)
    try:
        yield pg
    finally:
        set_pool(None)
        await pg.cleanup()
        await pool.close()


@pytest.fixture
def app(backend: Backend) -> FastAPI:
    application = create_app(settings=make_settings(), devices=InMemoryDeviceStore())
    if backend.store is not None:
        application.state.events = backend.store
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def habit(backend: Backend) -> str:
    return await backend.new_habit()


@dataclass
class Device:
    id: UUID
    headers: dict[str, str]


async def device(backend: Backend, kind: str = "iphone") -> Device:
    device_id = await backend.new_device(kind)
    token = issue_access(device_id, kind, SECRET, TTL)
    return Device(device_id, {"Authorization": f"Bearer {token}"})


@pytest.fixture
async def iphone(backend: Backend) -> Device:
    return await device(backend, "iphone")


def event(
    type_: str = "app_opened",
    payload: dict[str, Any] | None = None,
    *,
    at: str = NOON,
    id_: UUID | None = None,
    tz: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": str(id_ or uuid4()),
        "type": type_,
        "payload": {} if payload is None else payload,
        "occurred_at": at,
    }
    if tz is not None:
        body["tz"] = tz
    return body


def logged(code: str, status: str = "done", **extra: Any) -> dict[str, Any]:
    return {"habit_code": code, "status": status, **extra}


async def post(
    client: httpx.AsyncClient, dev: Device, events: list[dict[str, Any]]
) -> httpx.Response:
    return await client.post("/v1/events", json={"events": events}, headers=dev.headers)


async def pull(client: httpx.AsyncClient, dev: Device, **params: Any) -> dict[str, Any]:
    response = await client.get("/v1/events", params=params, headers=dev.headers)
    assert response.status_code == 200, response.text
    return response.json()


def ids_of(events: list[dict[str, Any]]) -> list[UUID]:
    return [UUID(e["id"]) for e in events]


# --- the cases from the task -------------------------------------------------------------------


async def test_the_same_batch_twice_stores_it_once_and_is_not_rejected(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    batch = [
        event("habit_logged", logged(habit, value=1)),
        event("habit_skipped", {"habit_code": habit, "day": "2026-11-09"}),
        event("app_opened"),
    ]
    first = await post(client, iphone, batch)
    second = await post(client, iphone, batch)
    assert first.status_code == second.status_code == 200
    assert first.json() == {"accepted": 3, "duplicates": 0}
    assert second.json() == {"accepted": 0, "duplicates": 3}
    assert await backend.event_count([UUID(e["id"]) for e in batch]) == 3
    assert await backend.habit_log_count(habit) == 2  # the replay projected nothing again


async def test_skip_status_makes_a_skip_row(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    response = await post(client, iphone, [event("habit_logged", logged(habit, "skip"))])
    assert response.json() == {"accepted": 1, "duplicates": 0}
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert row.status == "skip"
    assert row.value is None


@pytest.mark.parametrize("status", ["skip", "vacation"])
async def test_a_value_sent_with_skip_or_vacation_is_not_stored(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str, status: str
) -> None:
    await post(client, iphone, [event("habit_logged", logged(habit, status, value=3))])
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.status, row.value) == (status, None)


async def test_skipping_a_day_that_was_done_clears_its_value(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    await post(client, iphone, [event("habit_logged", logged(habit, value=5), at=NOON)])
    later = event("habit_logged", logged(habit, "skip", value=3), at="2026-11-10T10:00:00Z")
    await post(client, iphone, [later])
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.status, row.value) == ("skip", None)  # not the 5 from before, not the 3 sent


async def test_an_unknown_type_is_a_422_and_nothing_is_stored(
    client: httpx.AsyncClient, backend: Backend, iphone: Device
) -> None:
    good, bad = event("app_opened"), event("not_a_type")
    response = await post(client, iphone, [good, bad])
    assert response.status_code == 422
    body = response.json()
    assert body["detail"] == INVALID
    assert body["errors"][0]["loc"][:3] == ["body", "events", 1]  # points at the bad event
    assert await backend.event_count([UUID(good["id"])]) == 0  # the batch is all or nothing


async def test_a_day_eight_days_back_is_a_422(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    bad = event("habit_logged", logged(habit, day="2026-11-02"))
    response = await post(client, iphone, [bad])
    assert response.status_code == 422
    assert response.json()["errors"][0]["type"] == "day_out_of_window"
    assert await backend.event_count([UUID(bad["id"])]) == 0


async def test_a_day_seven_days_back_is_accepted(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    response = await post(client, iphone, [event("habit_logged", logged(habit, day="2026-11-03"))])
    assert response.json() == {"accepted": 1, "duplicates": 0}
    assert await backend.habit_log(habit, date(2026, 11, 3)) is not None


async def test_two_edits_arriving_in_reverse_order_keep_the_newest(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    older = event("habit_logged", logged(habit, value=2), at="2026-11-10T09:00:00Z")
    newer = event("habit_logged", logged(habit, value=5), at="2026-11-10T09:05:00Z")
    assert (await post(client, iphone, [newer])).json()["accepted"] == 1  # the newest arrives first
    assert (await post(client, iphone, [older])).json()["accepted"] == 1  # then the stale edit
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert row.value == Decimal(5)
    assert row.event_id == UUID(newer["id"])
    assert row.logged_at == datetime(2026, 11, 10, 9, 5, tzinfo=UTC)
    assert await backend.habit_log_count(habit) == 1


@pytest.mark.parametrize("newest_first", [True, False])
async def test_two_edits_in_one_batch_keep_the_newest_in_either_order(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str, newest_first: bool
) -> None:
    older = event("habit_logged", logged(habit, value=2), at="2026-11-10T09:00:00Z")
    newer = event("habit_logged", logged(habit, value=5), at="2026-11-10T09:05:00Z")
    batch = [newer, older] if newest_first else [older, newer]
    assert (await post(client, iphone, batch)).json() == {"accepted": 2, "duplicates": 0}
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert row.value == Decimal(5)


async def test_an_edit_made_later_replaces_the_earlier_one(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    await post(client, iphone, [event("habit_logged", logged(habit, value=1), at=NOON)])
    later = event("habit_logged", logged(habit, "skip"), at="2026-11-10T10:00:00Z")
    await post(client, iphone, [later])
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.status, row.value, row.event_id) == ("skip", None, UUID(later["id"]))


async def test_equal_event_times_let_the_later_arrival_win(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    first = event("habit_logged", logged(habit, value=1), at=NOON)
    second = event("habit_logged", logged(habit, value=9), at=NOON)
    await post(client, iphone, [first])
    await post(client, iphone, [second])
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert row.value == Decimal(9)  # `>=`: a tie is a re-save of the same moment


async def test_a_replayed_event_is_never_applied_again_even_on_a_time_tie(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    """With equal event times `>=` would let a re-applied old edit win: duplicates must not run."""
    first = event("habit_logged", logged(habit, value=1), at=NOON)
    second = event("habit_logged", logged(habit, value=9), at=NOON)
    await post(client, iphone, [first])
    await post(client, iphone, [second])
    replay = await post(client, iphone, [first])
    assert replay.json() == {"accepted": 0, "duplicates": 1}
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.value, row.event_id) == (Decimal(9), UUID(second["id"]))


async def test_replaying_an_old_batch_does_not_undo_a_newer_edit(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    old = [event("habit_logged", logged(habit, value=1), at=NOON)]
    await post(client, iphone, old)
    await post(
        client, iphone, [event("habit_logged", logged(habit, value=7), at="2026-11-10T11:00:00Z")]
    )
    replay = await post(client, iphone, old)
    assert replay.json() == {"accepted": 0, "duplicates": 1}
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert row.value == Decimal(7)


# --- days ---------------------------------------------------------------------------------------


async def test_an_event_just_before_riyadh_midnight_belongs_to_the_next_local_day(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    await post(client, iphone, [event("habit_logged", logged(habit), at="2026-11-09T23:30:00Z")])
    assert await backend.habit_log(habit, date(2026, 11, 10)) is not None
    assert await backend.habit_log(habit, date(2026, 11, 9)) is None


async def test_the_day_follows_the_tz_sent_with_the_event(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    ev = event("habit_logged", logged(habit), at="2026-11-09T23:30:00Z", tz="America/New_York")
    await post(client, iphone, [ev])
    assert await backend.habit_log(habit, date(2026, 11, 9)) is not None


async def test_yesterday_logged_today_lands_on_yesterday_and_leaves_today_alone(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    today = event("habit_logged", logged(habit, value=1), at=NOON)
    yesterday = event("habit_logged", logged(habit, value=3, day="2026-11-09"), at=NOON)
    await post(client, iphone, [today, yesterday])
    today_row = await backend.habit_log(habit, date(2026, 11, 10))
    yesterday_row = await backend.habit_log(habit, date(2026, 11, 9))
    assert today_row is not None
    assert yesterday_row is not None
    assert (today_row.value, yesterday_row.value) == (Decimal(1), Decimal(3))


# --- identity and source come from the token ----------------------------------------------------


async def test_device_id_is_taken_from_the_token_not_the_body(
    client: httpx.AsyncClient, iphone: Device
) -> None:
    ev = event("app_opened") | {"device_id": str(uuid4())}  # a forged device id in the body
    response = await client.post(
        "/v1/events", json={"events": [ev], "device_id": str(uuid4())}, headers=iphone.headers
    )
    assert response.json() == {"accepted": 1, "duplicates": 0}
    page = await pull(client, iphone)
    mine = next(e for e in page["events"] if e["id"] == ev["id"])
    assert mine["device_id"] == str(iphone.id)


async def test_the_habit_log_source_is_the_device_kind(
    client: httpx.AsyncClient, backend: Backend, habit: str
) -> None:
    web = await device(backend, "web")
    await post(client, web, [event("habit_logged", logged(habit, value=3))])
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.source, row.value) == ("web", Decimal(3))


# --- one row per habit and day, whatever the device (I-10) -------------------------------------


async def test_a_phone_correction_replaces_the_web_value_of_the_same_day(
    client: httpx.AsyncClient, backend: Backend, habit: str
) -> None:
    """30 minutes on the web, corrected to 45 on the phone: one row, 45, never 75."""
    web, phone = await device(backend, "web"), await device(backend, "iphone")
    first = event("habit_logged", logged(habit, value=30), at="2026-11-10T09:00:00Z")
    second = event("habit_logged", logged(habit, value=45), at="2026-11-10T09:30:00Z")
    assert (await post(client, web, [first])).json() == {"accepted": 1, "duplicates": 0}
    assert (await post(client, phone, [second])).json() == {"accepted": 1, "duplicates": 0}
    assert await backend.habit_log_count(habit) == 1
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.value, row.source, row.event_id) == (Decimal(45), "iphone", UUID(second["id"]))
    # what the readers (today, overview, progress, push) get, and what the rules make of it
    logs = await backend.reader_logs(habit)
    assert [(log.day, log.value, log.status) for log in logs] == [
        (date(2026, 11, 10), Decimal(45), "done")
    ]
    rule_logs = [
        HabitLogRule(log.day, None if log.value is None else float(log.value), "done")
        for log in logs
    ]
    progress = period_progress(COUNT_DAILY, rule_logs, date(2026, 11, 10), "sun")
    assert progress.done == 45.0


async def test_an_older_event_from_another_device_does_not_overwrite_a_newer_one(
    client: httpx.AsyncClient, backend: Backend, habit: str
) -> None:
    phone, watch = await device(backend, "iphone"), await device(backend, "watch")
    newer = event("habit_logged", logged(habit, value=45), at="2026-11-10T09:30:00Z")
    older = event("habit_logged", logged(habit, value=30), at="2026-11-10T09:00:00Z")
    await post(client, phone, [newer])
    assert (await post(client, watch, [older])).json() == {"accepted": 1, "duplicates": 0}
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.value, row.source, row.event_id) == (Decimal(45), "iphone", UUID(newer["id"]))
    assert await backend.habit_log_count(habit) == 1


@pytest.mark.parametrize("newest_first", [True, False])
async def test_two_devices_in_either_arrival_order_keep_the_newest(
    client: httpx.AsyncClient, backend: Backend, habit: str, newest_first: bool
) -> None:
    """The same day from two device kinds, in either arrival order: the newest wins."""
    web, phone = await device(backend, "web"), await device(backend, "iphone")
    older = event("habit_logged", logged(habit, value=30), at="2026-11-10T09:00:00Z")
    newer = event("habit_logged", logged(habit, value=45), at="2026-11-10T09:30:00Z")
    sends = [(phone, newer), (web, older)] if newest_first else [(web, older), (phone, newer)]
    for dev, ev in sends:
        await post(client, dev, [ev])
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.value, row.source) == (Decimal(45), "iphone")


async def test_a_later_skip_from_another_device_replaces_a_done(
    client: httpx.AsyncClient, backend: Backend, habit: str
) -> None:
    web, watch = await device(backend, "web"), await device(backend, "watch")
    await post(client, web, [event("habit_logged", logged(habit, value=2), at=NOON)])
    skip = event("habit_skipped", {"habit_code": habit}, at="2026-11-10T10:00:00Z")
    await post(client, watch, [skip])
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.status, row.value, row.source) == ("skip", None, "watch")
    assert await backend.habit_log_count(habit) == 1


async def test_equal_times_from_two_devices_let_the_later_arrival_win(
    client: httpx.AsyncClient, backend: Backend, habit: str
) -> None:
    web, phone = await device(backend, "web"), await device(backend, "iphone")
    await post(client, web, [event("habit_logged", logged(habit, value=1), at=NOON)])
    second = event("habit_logged", logged(habit, value=9), at=NOON)
    await post(client, phone, [second])
    row = await backend.habit_log(habit, date(2026, 11, 10))
    assert row is not None
    assert (row.value, row.source, row.event_id) == (Decimal(9), "iphone", UUID(second["id"]))


async def test_different_days_from_different_devices_stay_separate_rows(
    client: httpx.AsyncClient, backend: Backend, habit: str
) -> None:
    web, phone = await device(backend, "web"), await device(backend, "iphone")
    await post(client, web, [event("habit_logged", logged(habit, value=1, day="2026-11-09"))])
    await post(client, phone, [event("habit_logged", logged(habit, value=2))])
    assert await backend.habit_log_count(habit) == 2
    yesterday = await backend.habit_log(habit, date(2026, 11, 9))
    today = await backend.habit_log(habit, date(2026, 11, 10))
    assert yesterday is not None
    assert today is not None
    assert (yesterday.source, yesterday.value) == ("web", Decimal(1))
    assert (today.source, today.value) == ("iphone", Decimal(2))


async def test_the_same_event_id_from_two_devices_is_stored_once(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    phone, watch = await device(backend, "iphone"), await device(backend, "watch")
    ev = event("app_opened")
    assert (await post(client, phone, [ev])).json() == {"accepted": 1, "duplicates": 0}
    assert (await post(client, watch, [ev])).json() == {"accepted": 0, "duplicates": 1}


# --- statuses and the other projections ---------------------------------------------------------


async def test_skip_and_vacation_events_project_their_status(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    other = await backend.new_habit()
    await post(
        client,
        iphone,
        [
            event("habit_skipped", {"habit_code": habit, "value": 4}),
            event("habit_vacation", {"habit_code": other}),
        ],
    )
    day = date(2026, 11, 10)
    skipped, vacation = (
        await backend.habit_log(habit, day),
        await backend.habit_log(other, day),
    )
    assert skipped is not None
    assert vacation is not None
    assert (skipped.status, skipped.value) == ("skip", None)
    assert (vacation.status, vacation.value) == ("vacation", None)


async def test_focus_ended_is_projected_to_focus_sessions(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    ev = event(
        "focus_ended",
        {
            "habit_code": habit,
            "goal_ref": "G7",
            "started_at": "2026-11-10T08:00:00Z",
            "ended_at": "2026-11-10T08:50:00Z",
            "planned_minutes": 45,
            "actual_minutes": 50,
            "focus_rating": 4,
            "next_step": "راجع الملخص",
        },
        at="2026-11-10T08:50:00Z",
    )
    bare = event("focus_ended", {}, at=NOON)
    await post(client, iphone, [ev, bare])
    rows = {r["event_id"]: r for r in await backend.focus_rows([UUID(ev["id"]), UUID(bare["id"])])}
    full = rows[UUID(ev["id"])]
    assert full["habit_code"] == habit
    assert full["goal_ref"] == "G7"
    assert full["day"] == date(2026, 11, 10)
    assert full["started_at"] == datetime(2026, 11, 10, 8, 0, tzinfo=UTC)
    assert full["ended_at"] == datetime(2026, 11, 10, 8, 50, tzinfo=UTC)
    assert (full["planned_minutes"], full["actual_minutes"], full["focus_rating"]) == (
        45,
        Decimal(50),
        4,
    )
    assert full["next_step"] == "راجع الملخص"
    empty = rows[UUID(bare["id"])]  # missing columns are NULL, the times fall back to the event
    assert (empty["habit_code"], empty["goal_ref"], empty["planned_minutes"]) == (None, None, None)
    assert (empty["actual_minutes"], empty["focus_rating"], empty["next_step"]) == (
        None,
        None,
        None,
    )
    assert empty["started_at"] == empty["ended_at"] == datetime(2026, 11, 10, 9, 0, tzinfo=UTC)


async def test_breath_ended_is_projected_to_breath_sessions(
    client: httpx.AsyncClient, backend: Backend, iphone: Device
) -> None:
    ev = event(
        "breath_ended",
        {"pattern": "box", "duration_seconds": 300, "breaths_per_min": 6, "completed": False},
    )
    default = event("breath_ended", {"pattern": "4-7-8"})
    await post(client, iphone, [ev, default])
    rows = {
        r["event_id"]: r for r in await backend.breath_rows([UUID(ev["id"]), UUID(default["id"])])
    }
    row = rows[UUID(ev["id"])]
    assert (row["pattern"], row["duration_seconds"], row["breaths_per_min"]) == (
        "box",
        300,
        Decimal(6),
    )
    assert row["completed"] is False
    assert row["started_at"] == datetime(2026, 11, 10, 8, 55, tzinfo=UTC)  # ended - 300 s
    assert row["ended_at"] == datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
    assert row["day"] == date(2026, 11, 10)
    assert rows[UUID(default["id"])]["completed"] is True


async def test_session_events_are_projected_once_even_when_replayed(
    client: httpx.AsyncClient, backend: Backend, iphone: Device
) -> None:
    batch = [event("focus_ended", {}), event("breath_ended", {"pattern": "box"})]
    await post(client, iphone, batch)
    await post(client, iphone, batch)
    ids = [UUID(e["id"]) for e in batch]
    assert len(await backend.focus_rows(ids)) == 1
    assert len(await backend.breath_rows(ids)) == 1


@pytest.mark.parametrize(
    "type_", ["day_closed", "focus_started", "confounder_tagged", "app_opened"]
)
async def test_the_other_types_are_stored_only_in_events(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str, type_: str
) -> None:
    ev = event(type_, {"note": "ملاحظة", "n": [1, 2], "habit_code": habit})
    assert (await post(client, iphone, [ev])).json() == {"accepted": 1, "duplicates": 0}
    assert await backend.habit_log_count(habit) == 0
    assert await backend.focus_rows([UUID(ev["id"])]) == []
    assert await backend.breath_rows([UUID(ev["id"])]) == []
    stored = next(e for e in (await pull(client, iphone))["events"] if e["id"] == ev["id"])
    assert stored["type"] == type_
    assert stored["payload"] == ev["payload"]  # the payload comes back exactly as sent


async def test_goal_task_set_updates_done_at_and_ignores_older_or_unknown_task(
    client: httpx.AsyncClient, backend: Backend, iphone: Device
) -> None:
    task_id = await backend.new_goal_task()
    mark_done = event(
        "goal_task_set",
        {"task_id": str(task_id), "done": True},
        at="2026-11-10T10:00:00Z",
    )
    older_unmark = event(
        "goal_task_set",
        {"task_id": str(task_id), "done": False},
        at="2026-11-10T09:00:00Z",
    )
    newer_unmark = event(
        "goal_task_set",
        {"task_id": str(task_id), "done": False},
        at="2026-11-10T11:00:00Z",
    )
    ghost_task = event(
        "goal_task_set",
        {"task_id": str(uuid4()), "done": True},
        at="2026-11-10T10:00:00Z",
    )

    assert (await post(client, iphone, [mark_done, ghost_task])).json() == {
        "accepted": 2,
        "duplicates": 0,
    }
    assert await backend.goal_task_done(task_id) == (
        datetime(2026, 11, 10, 10, 0, tzinfo=UTC),
        datetime(2026, 11, 10, 10, 0, tzinfo=UTC),
    )
    assert await backend.event_count([UUID(ghost_task["id"])]) == 1

    # Older event does not overwrite
    assert (await post(client, iphone, [older_unmark])).json() == {"accepted": 1, "duplicates": 0}
    assert await backend.goal_task_done(task_id) == (
        datetime(2026, 11, 10, 10, 0, tzinfo=UTC),
        datetime(2026, 11, 10, 10, 0, tzinfo=UTC),
    )

    # Newer event overwrites
    assert (await post(client, iphone, [newer_unmark])).json() == {"accepted": 1, "duplicates": 0}
    assert await backend.goal_task_done(task_id) == (
        None,
        datetime(2026, 11, 10, 11, 0, tzinfo=UTC),
    )


# --- unknown habit ------------------------------------------------------------------------------


async def test_an_unknown_habit_rejects_the_whole_batch_and_stores_nothing(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    fine = event("habit_logged", logged(habit))
    ghost = event("habit_logged", logged("no-such-habit"))
    ghost_focus = event("focus_ended", {"habit_code": "no-such-habit-either"})
    response = await post(client, iphone, [fine, ghost, ghost_focus])
    assert response.status_code == 422
    errors = response.json()["errors"]
    assert response.json()["detail"] == INVALID
    assert [e["type"] for e in errors] == ["unknown_habit", "unknown_habit"]
    assert [e["loc"][2] for e in errors] == [1, 2]  # the positions of the two bad events
    assert errors[0]["loc"][3:] == ["payload", "habit_code"]
    ids = [UUID(e["id"]) for e in (fine, ghost, ghost_focus)]
    assert await backend.event_count(ids) == 0  # rolled back, including the good event
    assert await backend.habit_log_count(habit) == 0


async def test_replaying_an_accepted_batch_is_never_rejected(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, habit: str
) -> None:
    batch = [event("habit_logged", logged(habit))]
    assert (await post(client, iphone, batch)).status_code == 200
    replay = await post(client, iphone, batch)  # duplicates are not re-checked or re-projected
    assert replay.status_code == 200
    assert replay.json() == {"accepted": 0, "duplicates": 1}


# --- the envelope over HTTP ---------------------------------------------------------------------


async def test_a_naive_occurred_at_is_a_422(client: httpx.AsyncClient, iphone: Device) -> None:
    response = await post(client, iphone, [event("app_opened", at="2026-11-10T09:00:00")])
    assert response.status_code == 422
    assert response.json()["errors"][0]["loc"][:3] == ["body", "events", 0]


async def test_a_numeric_occurred_at_is_a_422(client: httpx.AsyncClient, iphone: Device) -> None:
    ev = event("app_opened") | {"occurred_at": 1762765200}
    assert (await post(client, iphone, [ev])).status_code == 422


async def test_an_event_more_than_24_hours_ahead_is_a_422_and_nothing_is_stored(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, server_now: datetime
) -> None:
    ahead = (server_now + timedelta(hours=24, seconds=1)).isoformat()
    bad = event("app_opened", at=ahead)
    response = await post(client, iphone, [event("app_opened"), bad])
    assert response.status_code == 422
    assert response.json()["errors"][0]["type"] == "occurred_at_in_future"
    assert response.json()["errors"][0]["loc"][:3] == ["body", "events", 1]
    assert await backend.event_count([UUID(bad["id"])]) == 0


async def test_an_event_exactly_24_hours_ahead_is_accepted(
    client: httpx.AsyncClient, iphone: Device, server_now: datetime
) -> None:
    edge = (server_now + timedelta(hours=24)).isoformat()
    assert (await post(client, iphone, [event("app_opened", at=edge)])).json() == {
        "accepted": 1,
        "duplicates": 0,
    }


SESSION_TYPES = [("focus_ended", {}), ("breath_ended", {"pattern": "box"})]


@pytest.mark.parametrize(("type_", "base"), SESSION_TYPES, ids=["focus", "breath"])
@pytest.mark.parametrize(
    ("fields", "code"),
    [
        ({"ended_at": "@"}, "ended_at_in_future"),
        ({"started_at": "@", "ended_at": "@"}, "started_at_in_future"),
    ],
    ids=["ended", "started"],
)
async def test_session_times_more_than_24_hours_ahead_are_a_422(
    client: httpx.AsyncClient,
    backend: Backend,
    iphone: Device,
    server_now: datetime,
    type_: str,
    base: dict[str, Any],
    fields: dict[str, str],
    code: str,
) -> None:
    """`started_at` / `ended_at` get the same 24 h cap as `occurred_at` (it is checked first)."""
    ahead = (server_now + timedelta(hours=24, seconds=1)).isoformat()
    bad = event(type_, base | {key: ahead for key in fields})
    response = await post(client, iphone, [event("app_opened"), bad])
    assert response.status_code == 422
    assert response.json()["errors"][0]["type"] == code
    assert response.json()["errors"][0]["loc"][:3] == ["body", "events", 1]
    assert await backend.event_count([UUID(bad["id"])]) == 0


@pytest.mark.parametrize(("type_", "base"), SESSION_TYPES, ids=["focus", "breath"])
async def test_session_times_exactly_24_hours_ahead_are_accepted(
    client: httpx.AsyncClient,
    iphone: Device,
    server_now: datetime,
    type_: str,
    base: dict[str, Any],
) -> None:
    edge = (server_now + timedelta(hours=24)).isoformat()
    body = base | {"started_at": NOON, "ended_at": edge}
    response = await post(client, iphone, [event(type_, body)])
    assert response.json() == {"accepted": 1, "duplicates": 0}


async def test_tz_defaults_to_riyadh_and_unknown_tz_is_a_422(
    client: httpx.AsyncClient, iphone: Device
) -> None:
    ev = event("app_opened")
    assert "tz" not in ev
    await post(client, iphone, [ev])
    stored = next(e for e in (await pull(client, iphone))["events"] if e["id"] == ev["id"])
    assert stored["tz"] == "Asia/Riyadh"
    assert (await post(client, iphone, [event("app_opened", tz="Mars/Base")])).status_code == 422


async def test_an_empty_batch_is_accepted(client: httpx.AsyncClient, iphone: Device) -> None:
    response = await post(client, iphone, [])
    assert response.status_code == 200
    assert response.json() == {"accepted": 0, "duplicates": 0}


async def test_five_hundred_events_are_accepted_and_501_are_not(
    client: httpx.AsyncClient, backend: Backend, iphone: Device
) -> None:
    five_hundred = [event("app_opened") for _ in range(500)]
    assert (await post(client, iphone, five_hundred)).json() == {"accepted": 500, "duplicates": 0}
    too_many = [event("app_opened") for _ in range(501)]
    response = await post(client, iphone, too_many)
    assert response.status_code == 422
    assert response.json()["errors"][0]["type"] == "too_long"
    assert await backend.event_count([UUID(e["id"]) for e in too_many]) == 0


async def test_duplicate_ids_inside_one_batch_count_once(
    client: httpx.AsyncClient, backend: Backend, iphone: Device
) -> None:
    ev = event("app_opened")
    response = await post(client, iphone, [ev, ev])
    assert response.json() == {"accepted": 1, "duplicates": 1}
    assert await backend.event_count([UUID(ev["id"])]) == 1


def raw_event(note_json: str) -> str:
    """A request body written by hand, so a test can put an escape sequence in the JSON text."""
    one = {
        "id": str(uuid4()),
        "type": "confounder_tagged",
        "occurred_at": NOON,
        "payload": {"note": "@"},
    }
    return json.dumps({"events": [one]}).replace("@", note_json)


@pytest.mark.parametrize("escape", ["u0000", "ud800", "udfff"])
async def test_text_postgres_cannot_store_is_a_422_not_a_500(
    client: httpx.AsyncClient, iphone: Device, escape: str
) -> None:
    body = raw_event("a" + chr(92) + escape + "b")  # a JSON escape for NUL or a lone surrogate
    response = await client.post(
        "/v1/events", content=body, headers=iphone.headers | {"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert response.json()["errors"][0]["type"] == "payload_text_invalid"
    assert "x-request-id" in response.headers


def raw_number_event(literal: str) -> tuple[str, str]:
    """A body whose payload holds `literal` as a bare JSON number token; also the event id."""
    one = {
        "id": str(uuid4()),
        "type": "confounder_tagged",
        "occurred_at": NOON,
        "payload": {"n": "@"},
    }
    return json.dumps({"events": [one]}).replace('"@"', literal), one["id"]


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity", "1e999", "-1e999"])
async def test_numbers_json_cannot_represent_are_a_422_not_a_500(
    client: httpx.AsyncClient, backend: Backend, iphone: Device, literal: str
) -> None:
    """Python parses these tokens; `jsonb` would reject them and the insert would be a 500."""
    body, event_id = raw_number_event(literal)
    response = await client.post(
        "/v1/events", content=body, headers=iphone.headers | {"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    assert response.json()["detail"] == INVALID
    assert response.json()["errors"][0]["type"] == "payload_not_finite"
    assert response.json()["errors"][0]["loc"][:3] == ["body", "events", 0]
    assert "x-request-id" in response.headers
    assert await backend.event_count([UUID(event_id)]) == 0


async def test_the_store_refuses_a_non_finite_payload_even_if_validation_was_skipped(
    backend: Backend,
) -> None:
    """Defence in depth: the store serialises with allow_nan=False and rejects, never a 500."""
    store = backend.make_store()
    good = EventIn(id=uuid4(), type="confounder_tagged", payload={"n": 1}, occurred_at=NOON)
    bad = EventIn.model_construct(
        id=uuid4(),
        type="confounder_tagged",
        payload={"n": float("nan")},
        occurred_at=datetime(2026, 11, 10, 9, 0, tzinfo=UTC),
        tz="Asia/Riyadh",
    )
    device_id = await backend.new_device("iphone")
    with pytest.raises(InvalidPayloads) as exc:
        await store.ingest(device_id, plan([good, bad], "iphone"))
    assert exc.value.indexes == [1]
    assert await backend.event_count([good.id, bad.id]) == 0  # nothing was stored


async def test_arabic_text_survives_storage(client: httpx.AsyncClient, iphone: Device) -> None:
    ev = event("confounder_tagged", {"note": "يوم هادئ ومثمر، والحمد لله"})
    await post(client, iphone, [ev])
    stored = next(e for e in (await pull(client, iphone))["events"] if e["id"] == ev["id"])
    assert stored["payload"]["note"] == "يوم هادئ ومثمر، والحمد لله"


async def test_payloads_are_never_logged(
    client: httpx.AsyncClient, iphone: Device, caplog: pytest.LogCaptureFixture
) -> None:
    secret = "ملاحظة-سرية-13579"
    with caplog.at_level(logging.DEBUG):
        await post(client, iphone, [event("confounder_tagged", {"note": secret})])
        await pull(client, iphone)
    assert secret not in caplog.text
    lines = [r.getMessage() for r in caplog.records if r.name == "yawmi.access"]
    assert any("POST /v1/events" in line and "200" in line for line in lines)


async def test_a_rejected_event_is_not_echoed_back(
    client: httpx.AsyncClient, iphone: Device
) -> None:
    secret = "قيمة-سرية-24680" * 10  # too long for a habit code, so the event is rejected
    response = await post(client, iphone, [event("habit_logged", {"habit_code": secret})])
    assert response.status_code == 422
    assert "24680" not in response.text


# --- auth ---------------------------------------------------------------------------------------


async def test_post_without_a_token_is_401_even_with_an_invalid_body(
    client: httpx.AsyncClient,
) -> None:
    valid = await client.post("/v1/events", json={"events": []})
    invalid = await client.post("/v1/events", json={"nope": 1})
    assert valid.status_code == invalid.status_code == 401
    assert valid.json() == invalid.json() == UNAUTHORIZED


async def test_get_without_a_token_is_401(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/events")
    assert response.status_code == 401
    assert response.json() == UNAUTHORIZED


async def test_an_expired_token_is_401(client: httpx.AsyncClient) -> None:
    token = issue_access(uuid4(), "iphone", SECRET, -10)
    response = await client.get("/v1/events", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


async def test_a_service_token_cannot_post_events_but_can_pull(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    service = await device(backend, "service")
    response = await post(client, service, [event("app_opened")])
    assert response.status_code == 403
    assert response.json() == FORBIDDEN
    assert (await client.get("/v1/events", headers=service.headers)).status_code == 200


# --- pull ---------------------------------------------------------------------------------------


async def test_pull_returns_events_in_received_order_with_a_cursor(
    client: httpx.AsyncClient, iphone: Device
) -> None:
    before = datetime.now(UTC) - timedelta(seconds=1)
    batch = [
        event("app_opened", at=f"2026-11-10T0{n}:00:00Z") for n in (9, 3, 6)
    ]  # not time-sorted
    await post(client, iphone, batch)
    page = await pull(client, iphone, since=before.isoformat())
    assert [e["id"] for e in page["events"]] == [e["id"] for e in batch]  # received, not occurred
    received = [e["received_at"] for e in page["events"]]
    assert received == sorted(received)
    assert page["next_since"] == received[-1]
    first = page["events"][0]
    assert set(first) == {"id", "device_id", "type", "payload", "occurred_at", "tz", "received_at"}
    assert datetime.fromisoformat(first["occurred_at"]) == datetime(2026, 11, 10, 9, 0, tzinfo=UTC)


async def test_pull_with_since_returns_only_what_is_newer(
    client: httpx.AsyncClient, iphone: Device
) -> None:
    before = datetime.now(UTC) - timedelta(seconds=1)
    first, second = event("app_opened"), event("app_opened")
    await post(client, iphone, [first])
    cursor = (await pull(client, iphone, since=before.isoformat()))["next_since"]
    await post(client, iphone, [second])
    page = await pull(client, iphone, since=cursor)
    assert [e["id"] for e in page["events"]] == [second["id"]]  # `>`: not the one at the cursor


async def test_an_empty_pull_echoes_the_since_it_was_given(
    client: httpx.AsyncClient, iphone: Device
) -> None:
    future = datetime(2099, 1, 1, tzinfo=UTC)
    page = await pull(client, iphone, since=future.isoformat())
    assert page["events"] == []
    assert datetime.fromisoformat(page["next_since"]) == future


@pytest.fixture
async def no_events(backend: Backend, iphone: Device) -> AsyncIterator[None]:
    """An empty `yawmi.events` for one test, without touching what other tests rely on.

    A shared Postgres database may already hold events (other modules leave theirs behind).
    The pool the routes use is swapped for one connection that sits in a transaction which
    truncates the table; the rollback restores every row, so nothing leaks into other tests,
    whatever their order. The in-memory backend starts empty and needs nothing.
    """
    if not isinstance(backend, PostgresBackend):
        yield
        return
    async with backend.pool.acquire() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            await conn.execute("TRUNCATE yawmi.events CASCADE")
            set_pool(cast(Any, _OneConnection(conn)))
            yield
        finally:
            set_pool(backend.pool)
            await transaction.rollback()


class _OneConnection:
    """Just enough of `asyncpg.Pool` for the read paths: every call runs on one connection."""

    def __init__(self, conn: asyncpg.Connection) -> None:
        self._conn = conn

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conn, name)


async def test_pull_without_a_cursor_and_without_events_has_a_null_cursor(
    client: httpx.AsyncClient, iphone: Device, no_events: None
) -> None:
    page = await pull(client, iphone)
    assert page == {"events": [], "next_since": None}


async def test_paging_through_one_batch_in_small_pages_loses_and_repeats_nothing(
    client: httpx.AsyncClient, iphone: Device
) -> None:
    """All events of a batch share one transaction: a page boundary must not drop the rest."""
    before = datetime.now(UTC) - timedelta(seconds=1)
    batch = [event("app_opened") for _ in range(7)]
    await post(client, iphone, batch)
    seen: list[str] = []
    cursor = before.isoformat()
    for _ in range(20):
        page = await pull(client, iphone, since=cursor, limit=2)
        if not page["events"]:
            break
        seen += [e["id"] for e in page["events"]]
        cursor = page["next_since"]
    assert seen == [e["id"] for e in batch]


async def test_a_page_never_ends_inside_a_group_of_equal_received_at(
    client: httpx.AsyncClient, backend: Backend, iphone: Device
) -> None:
    stamp = datetime(2031, 3, 3, 3, 3, 3, tzinfo=UTC)
    ids = await backend.seed_events(5, stamp)
    page = await pull(client, iphone, since=(stamp - timedelta(seconds=1)).isoformat(), limit=2)
    assert ids_of(page["events"]) == ids  # all five, though limit was 2
    assert datetime.fromisoformat(page["next_since"]) == stamp
    assert (await pull(client, iphone, since=page["next_since"]))["events"] == []


async def test_concurrent_batches_all_arrive_exactly_once_when_paged(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    devices = [await device(backend, "iphone") for _ in range(4)]
    before = datetime.now(UTC) - timedelta(seconds=1)
    batches = [[event("app_opened") for _ in range(6)] for _ in devices]
    results = await asyncio.gather(
        *(post(client, d, b) for d, b in zip(devices, batches, strict=True))
    )
    assert all(r.json() == {"accepted": 6, "duplicates": 0} for r in results)
    expected = {e["id"] for batch in batches for e in batch}
    seen: list[str] = []
    cursor = before.isoformat()
    for _ in range(40):
        page = await pull(client, devices[0], since=cursor, limit=5)
        if not page["events"]:
            break
        seen += [e["id"] for e in page["events"]]
        cursor = page["next_since"]
    assert len(seen) == len(set(seen)) == 24
    assert set(seen) == expected


@pytest.mark.parametrize("limit", [0, 501, -1, "abc"])
async def test_a_bad_limit_is_a_422(client: httpx.AsyncClient, iphone: Device, limit: Any) -> None:
    response = await client.get("/v1/events", params={"limit": limit}, headers=iphone.headers)
    assert response.status_code == 422
    assert response.json()["detail"] == INVALID


async def test_the_largest_limit_is_500(client: httpx.AsyncClient, iphone: Device) -> None:
    await pull(client, iphone, limit=500)


@pytest.mark.parametrize("since", ["2026-11-10T09:00:00", "not-a-date", "2026-11-10"])
async def test_a_naive_or_malformed_since_is_a_422(
    client: httpx.AsyncClient, iphone: Device, since: str
) -> None:
    response = await client.get("/v1/events", params={"since": since}, headers=iphone.headers)
    assert response.status_code == 422


async def test_since_accepts_an_offset_and_z_and_extreme_values(
    client: httpx.AsyncClient, iphone: Device
) -> None:
    for since in ("2026-11-10T12:00:00+03:00", "2026-11-10T09:00:00Z", "1970-01-01T00:00:00Z"):
        assert "events" in await pull(client, iphone, since=since)
    for extreme in ("0001-01-01T00:00:00+03:00", "9999-12-31T23:59:59-03:00"):
        assert (
            await client.get("/v1/events", params={"since": extreme}, headers=iphone.headers)
        ).status_code == 200


# --- the store's SQL is wired to the intents it receives (no database needed) -------------------


def placeholders(sql: str) -> int:
    return max(int(n) for n in re.findall(r"\$(\d+)", sql))


def test_the_sql_parameters_match_the_arguments_built_for_them() -> None:
    event_id, device_id = uuid4(), uuid4()
    at = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
    log = HabitLog(event_id, "h", date(2026, 11, 10), "done", None, "iphone", at)
    focus = FocusSession(event_id, None, None, date(2026, 11, 10), at, at, None, None, None, None)
    breath = BreathSession(event_id, date(2026, 11, 10), at, at, "box", None, None, True)
    assert placeholders(_UPSERT_HABIT_LOG) == len(habit_log_args(log)) == 8
    assert placeholders(_INSERT_FOCUS) == len(focus_args(focus, device_id)) == 11
    assert placeholders(_INSERT_BREATH) == len(breath_args(breath, device_id)) == 9


def test_upsert_habit_log_sql_is_one_row_per_day_and_newest_wins() -> None:
    assert "ON CONFLICT (habit_code, day) DO UPDATE" in _UPSERT_HABIT_LOG
    assert "source = excluded.source" in _UPSERT_HABIT_LOG
    assert "excluded.logged_at >= yawmi.habit_logs.logged_at" in _UPSERT_HABIT_LOG


def test_received_times_are_strictly_increasing_and_start_at_the_base() -> None:
    base = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
    times = received_times(base, 500)
    assert times[0] == base
    assert all(a < b for a, b in itertools.pairwise(times))
    assert times[-1] - base == timedelta(microseconds=499)
    assert received_times(base, 0) == []


async def test_the_in_memory_store_keeps_received_at_increasing_across_batches() -> None:
    frozen = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
    store = InMemoryEventStore(clock=lambda: frozen)  # a frozen clock must not repeat a time
    for _ in range(3):
        one = EventIn(id=uuid4(), type="app_opened", payload={}, occurred_at=NOON)
        await store.ingest(uuid4(), plan([one], "iphone"))
    times = [e.received_at for e in store.events.values()]
    assert len(set(times)) == 3
    assert times == sorted(times)


# --- received_at is monotonic: later batches always carry later times --------------------------


def test_next_received_base_never_goes_backwards() -> None:
    now = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
    one = timedelta(microseconds=1)
    assert next_received_base(now, None) == now  # empty table: the clock
    assert next_received_base(now, now - timedelta(seconds=5)) == now  # normal: the clock
    assert next_received_base(now, now) == now + one  # a tie: one microsecond after
    assert next_received_base(now, now + timedelta(hours=1)) == now + timedelta(hours=1) + one


def new_events(count: int) -> list[EventIn]:
    return [
        EventIn(id=uuid4(), type="app_opened", payload={}, occurred_at=NOON) for _ in range(count)
    ]


async def stored_times(store: EventStore, events: list[EventIn]) -> dict[UUID, datetime]:
    wanted = {e.id for e in events}
    page = await store.pull(None, 500)
    return {e.id: e.received_at for e in page if e.id in wanted}


async def test_received_at_keeps_increasing_across_batches_under_a_frozen_clock(
    backend: Backend,
) -> None:
    """Two batches in the same clock tick must not share or reorder their times."""
    frozen = datetime.now(UTC)
    store = backend.make_store(clock=lambda: frozen)
    device_id = await backend.new_device("iphone")
    first, second = new_events(3), new_events(3)
    await store.ingest(device_id, plan(first, "iphone"))
    await store.ingest(device_id, plan(second, "iphone"))
    times_a = [(await stored_times(store, first))[e.id] for e in first]
    times_b = [(await stored_times(store, second))[e.id] for e in second]
    assert times_a == sorted(times_a)
    assert len(set(times_a + times_b)) == 6  # no two events share a time
    assert min(times_b) > max(times_a)  # the later batch is entirely later


async def test_received_at_does_not_go_backwards_when_the_clock_does(backend: Backend) -> None:
    now = datetime.now(UTC)
    ticks = [now, now - timedelta(hours=1)]  # the second call sees a clock one hour earlier
    store = backend.make_store(clock=lambda: ticks[0])
    device_id = await backend.new_device("iphone")
    first, second = new_events(2), new_events(2)
    await store.ingest(device_id, plan(first, "iphone"))
    ticks[0] = ticks[1]
    await store.ingest(device_id, plan(second, "iphone"))
    times_a = await stored_times(store, first)
    times_b = await stored_times(store, second)
    assert min(times_b.values()) > max(times_a.values())


async def test_a_new_batch_lands_after_the_newest_time_already_stored(backend: Backend) -> None:
    """Whatever wrote that row (another writer, a stepped clock), the cursor must not skip it."""
    store = backend.make_store()  # first: in memory this replaces the store the seed goes into
    ahead = datetime.now(UTC) + timedelta(days=3)
    [seeded] = await backend.seed_events(1, ahead)
    device_id = await backend.new_device("iphone")
    [one] = new_events(1)
    await store.ingest(device_id, plan([one], "iphone"))
    assert (await stored_times(store, [one]))[one.id] == ahead + timedelta(microseconds=1)
    assert seeded  # the seeded row is the one the new event was ordered after
