"""`GET /v1/habit-logs` tests on both backends (memory and Postgres)."""

import os
from collections.abc import AsyncIterator
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Protocol
from uuid import uuid4

import asyncpg
import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.db.pool import create_pool, set_pool
from yawmi.main import create_app
from yawmi.settings import Settings
from yawmi.today.memory import InMemoryTodayReader
from yawmi.today.reader import HabitRow, LogRow

SECRET = "test-secret-for-unit-tests-only-0123456789"
PREFIX = "t3hl-"
IN_CI = bool(os.environ.get("CI"))
MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"
STUB_SQL = Path(__file__).parent / "fixtures" / "raqib_stub.sql"


class Backend(Protocol):
    def install(self, app: FastAPI) -> None: ...
    async def add_habit(self, code: str, *, kind: str = "duration", unit: str = "min") -> None: ...
    async def add_log(
        self, code: str, day: date, status: str = "done", value: Decimal | None = None
    ) -> None: ...


class MemoryBackend:
    def __init__(self) -> None:
        self._habits: list[HabitRow] = []
        self._logs: list[LogRow] = []
        self._app: FastAPI | None = None

    def install(self, app: FastAPI) -> None:
        self._app = app
        app.state.today = InMemoryTodayReader(habits=self._habits, logs=self._logs)

    async def add_habit(self, code: str, *, kind: str = "duration", unit: str = "min") -> None:
        self._habits.append(
            HabitRow(
                code=code,
                title_ar=code,
                goal_ref=None,
                outcome=None,
                kind=kind,  # type: ignore[arg-type]
                unit=unit,
                target_per_period=Decimal(25),
                period="day",
                schedule_kind="every_day",
                weekday_mask=None,
                every_n=None,
                anchor_day=None,
                start_day=date(2026, 1, 1),
                end_day=None,
            )
        )
        self._rebuild()

    async def add_log(
        self, code: str, day: date, status: str = "done", value: Decimal | None = None
    ) -> None:
        self._logs.append(LogRow(habit_code=code, day=day, value=value, status=status))  # type: ignore[arg-type]
        self._rebuild()

    def _rebuild(self) -> None:
        if self._app is not None:
            self._app.state.today = InMemoryTodayReader(habits=self._habits, logs=self._logs)


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    def install(self, app: FastAPI) -> None:
        pass

    async def add_habit(self, code: str, *, kind: str = "duration", unit: str = "min") -> None:
        await self.pool.execute(
            """
            INSERT INTO yawmi.habits (
              code, title_ar, kind, unit, target_per_period, period, schedule_kind,
              start_day, system, created_by, active
            )
            VALUES ($1, $2, $3, $4, 25, 'day', 'every_day', '2026-01-01', false, 'user', true)
            ON CONFLICT (code) DO NOTHING
            """,
            code,
            code,
            kind,
            unit or None,
        )

    async def add_log(
        self, code: str, day: date, status: str = "done", value: Decimal | None = None
    ) -> None:
        await self.pool.execute(
            """
            INSERT INTO yawmi.habit_logs (id, habit_code, day, value, status, source, logged_at)
            VALUES ($1, $2, $3, $4, $5, 'web', '2026-11-10T10:00:00Z')
            ON CONFLICT (habit_code, day) DO UPDATE
            SET value = excluded.value, status = excluded.status
            """,
            uuid4(),
            code,
            day,
            value,
            status,
        )

    async def cleanup(self) -> None:
        await self.pool.execute(
            "DELETE FROM yawmi.habit_logs WHERE habit_code LIKE $1", PREFIX + "%"
        )
        await self.pool.execute("DELETE FROM yawmi.habits WHERE code LIKE $1", PREFIX + "%")


async def ensure_schema(pool: asyncpg.Pool) -> None:
    await pool.execute(STUB_SQL.read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.habits') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0001_yawmi_schema.sql").read_text(encoding="utf-8"))
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
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await ensure_schema(pool)
    pg = PostgresBackend(pool)
    await pg.cleanup()
    set_pool(pool)
    try:
        yield pg
    finally:
        set_pool(None)
        await pg.cleanup()
        await pool.close()


@pytest.fixture
def app(backend: Backend) -> FastAPI:
    application = create_app(
        settings=Settings(
            database_url="postgresql://yawmi_api@localhost:5432/raqib",
            jwt_secret=SecretStr(SECRET),
        ),
        devices=InMemoryDeviceStore(),
    )
    backend.install(application)
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def auth(kind: str = "web") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(uuid4(), kind, SECRET, 900)}"}


async def test_range_of_400_days_is_accepted_and_401_is_rejected_with_range_too_large(
    client: httpx.AsyncClient,
) -> None:
    first = date(2026, 1, 1)
    ok_last = first + timedelta(days=400)
    bad_last = first + timedelta(days=401)

    ok_res = await client.get(
        "/v1/habit-logs",
        params={"from": first.isoformat(), "to": ok_last.isoformat()},
        headers=auth(),
    )
    assert ok_res.status_code == 200, ok_res.text

    bad_res = await client.get(
        "/v1/habit-logs",
        params={"from": first.isoformat(), "to": bad_last.isoformat()},
        headers=auth(),
    )
    assert bad_res.status_code == 422
    assert bad_res.json()["errors"][0]["type"] == "range_too_large"


async def test_code_filters_the_result_and_value_is_a_json_number(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    read_code = PREFIX + "read"
    walk_code = PREFIX + "walk"
    await backend.add_habit(read_code)
    await backend.add_habit(walk_code, kind="boolean", unit="")
    await backend.add_log(read_code, date(2026, 11, 10), "done", Decimal("25.0"))
    await backend.add_log(walk_code, date(2026, 11, 10), "skip", None)

    filtered = await client.get(
        "/v1/habit-logs",
        params={"from": "2026-11-01", "to": "2026-11-10", "code": read_code},
        headers=auth(),
    )
    assert filtered.status_code == 200, filtered.text
    logs = filtered.json()["logs"]
    assert logs == [
        {
            "habit_code": read_code,
            "day": "2026-11-10",
            "value": 25.0,
            "status": "done",
        }
    ]
    assert isinstance(logs[0]["value"], float | int) and not isinstance(logs[0]["value"], bool)
    assert '"value":25.0' in filtered.text.replace(" ", "")

    all_res = await client.get(
        "/v1/habit-logs",
        params={"from": "2026-11-01", "to": "2026-11-10"},
        headers=auth(),
    )
    assert all_res.status_code == 200
    codes = {
        row["habit_code"] for row in all_res.json()["logs"] if row["habit_code"].startswith(PREFIX)
    }
    assert codes == {read_code, walk_code}
