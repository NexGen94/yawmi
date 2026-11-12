"""`GET /v1/habit-logs` tests on both backends (memory and Postgres)."""

from collections.abc import AsyncIterator
from datetime import date, timedelta
from decimal import Decimal
from typing import Protocol
from uuid import uuid4

import asyncpg
import httpx
import pytest
from fastapi import FastAPI
from test_journal import auth, client, open_pg_pool  # type: ignore[import-not-found]

from yawmi.db.pool import set_pool
from yawmi.today.memory import InMemoryTodayReader
from yawmi.today.reader import HabitRow, LogRow

__all__ = ["client"]

PREFIX = "t3hl-"


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


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    if request.param == "memory":
        yield MemoryBackend()
        return
    pool = await open_pg_pool()
    pg = PostgresBackend(pool)
    await pg.cleanup()
    set_pool(pool)
    try:
        yield pg
    finally:
        set_pool(None)
        await pg.cleanup()
        await pool.close()


async def test_range_of_400_days_is_accepted_and_401_is_rejected_with_range_too_large(
    client: httpx.AsyncClient,
) -> None:
    first = date(2026, 1, 1)
    ok_last = first + timedelta(days=399)  # 400 calendar days inclusive: to - from <= 399
    bad_last = first + timedelta(days=400)  # 401 calendar days inclusive: to - from == 400 -> 422

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


async def test_null_status_log_is_omitted_and_never_reported_as_done(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    """A log with NULL status must not be returned by /v1/habit-logs, consistent with other readers."""
    code = PREFIX + "null_status"
    await backend.add_habit(code)
    await backend.add_log(code, date(2026, 11, 10), status=None)  # type: ignore[arg-type]

    res = await client.get(
        "/v1/habit-logs",
        params={"from": "2026-11-01", "to": "2026-11-10", "code": code},
        headers=auth(),
    )
    assert res.status_code == 200, res.text
    assert res.json()["logs"] == []
