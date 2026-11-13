"""Focus store protocol and Postgres implementation.

The plans are rows of `yawmi.focus_plans`. The sessions are the rows `yawmi.focus_sessions` and
`yawmi.breath_sessions` that the event projection writes (the same tables the AI grounding sums,
see `yawmi.ai.reader`); this store only reads them.
"""

from datetime import date, datetime, time
from typing import Any, Protocol
from uuid import UUID, uuid4

import asyncpg

from yawmi.focus.models import (
    BreathSessionOut,
    FocusPlanIO,
    FocusPlanOut,
    FocusSessionOut,
)

_PLAN_COLUMNS = (
    "id, title_ar, minutes, goal_ref, habit_code, favorite, weekday_mask, start_time, active,"
    " updated_at"
)
_PLAN_ORDER = "ORDER BY favorite DESC, updated_at DESC, id"

LIST_PLANS = f"SELECT {_PLAN_COLUMNS} FROM yawmi.focus_plans {_PLAN_ORDER}"
LIST_ACTIVE_PLANS = f"SELECT {_PLAN_COLUMNS} FROM yawmi.focus_plans WHERE active {_PLAN_ORDER}"

INSERT_PLAN = f"""
INSERT INTO yawmi.focus_plans (
    id, title_ar, minutes, goal_ref, habit_code, favorite, weekday_mask, start_time, active,
    updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
RETURNING {_PLAN_COLUMNS}
"""

LOCK_PLAN = f"SELECT {_PLAN_COLUMNS} FROM yawmi.focus_plans WHERE id = $1 FOR UPDATE"

UPDATE_PLAN = f"""
UPDATE yawmi.focus_plans SET
    title_ar = $2, minutes = $3, goal_ref = $4, habit_code = $5, favorite = $6,
    weekday_mask = $7, start_time = $8, active = $9, updated_at = now()
WHERE id = $1
RETURNING {_PLAN_COLUMNS}
"""

SELECT_FOCUS_SESSIONS = """
SELECT id, day, started_at, ended_at, planned_minutes, actual_minutes::float8 AS actual_minutes,
       goal_ref, habit_code, focus_rating, next_step
FROM yawmi.focus_sessions
WHERE day BETWEEN $1 AND $2
ORDER BY started_at, id
"""

SELECT_BREATH_SESSIONS = """
SELECT id, day, started_at, ended_at, pattern, breaths_per_min::float8 AS breaths_per_min,
       duration_seconds, completed, feeling
FROM yawmi.breath_sessions
WHERE day BETWEEN $1 AND $2
ORDER BY started_at, id
"""


class UnknownHabit(Exception):
    """A plan names a habit code that does not exist."""


def _clock(text: str | None) -> time | None:
    return datetime.strptime(text, "%H:%M").time() if text is not None else None


def _plan(r: asyncpg.Record) -> FocusPlanOut:
    return FocusPlanOut(
        id=r["id"],
        title_ar=r["title_ar"],
        minutes=r["minutes"],
        goal_ref=r["goal_ref"],
        habit_code=r["habit_code"],
        favorite=r["favorite"],
        weekday_mask=r["weekday_mask"],
        start_time=r["start_time"].strftime("%H:%M") if r["start_time"] is not None else None,
        active=r["active"],
        updated_at=r["updated_at"],
    )


class FocusStore(Protocol):
    async def plans(self, include_inactive: bool = False) -> list[FocusPlanOut]: ...
    async def add_plan(self, p: FocusPlanIO) -> FocusPlanOut: ...
    async def patch_plan(self, id: UUID, changes: dict[str, Any]) -> FocusPlanOut | None: ...
    async def sessions(self, first: date, last: date) -> list[FocusSessionOut]: ...
    async def breath_sessions(self, first: date, last: date) -> list[BreathSessionOut]: ...


class AsyncpgFocusStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def plans(self, include_inactive: bool = False) -> list[FocusPlanOut]:
        rows = await self._pool.fetch(LIST_PLANS if include_inactive else LIST_ACTIVE_PLANS)
        return [_plan(r) for r in rows]

    async def add_plan(self, p: FocusPlanIO) -> FocusPlanOut:
        try:
            row = await self._pool.fetchrow(
                INSERT_PLAN,
                uuid4(),
                p.title_ar,
                p.minutes,
                p.goal_ref,
                p.habit_code,
                p.favorite,
                p.weekday_mask,
                _clock(p.start_time),
                p.active,
            )
        except asyncpg.ForeignKeyViolationError:
            raise UnknownHabit(p.habit_code) from None
        assert row is not None
        return _plan(row)

    async def patch_plan(self, id: UUID, changes: dict[str, Any]) -> FocusPlanOut | None:
        """Merge `changes` into the stored plan under a row lock; `None` when there is no such plan."""
        async with self._pool.acquire() as conn, conn.transaction():
            current = await conn.fetchrow(LOCK_PLAN, id)
            if current is None:
                return None
            merged = {**_plan(current).model_dump(), **changes}
            try:
                row = await conn.fetchrow(
                    UPDATE_PLAN,
                    id,
                    merged["title_ar"],
                    merged["minutes"],
                    merged["goal_ref"],
                    merged["habit_code"],
                    merged["favorite"],
                    merged["weekday_mask"],
                    _clock(merged["start_time"]),
                    merged["active"],
                )
            except asyncpg.ForeignKeyViolationError:
                raise UnknownHabit(merged["habit_code"]) from None
        assert row is not None
        return _plan(row)

    async def sessions(self, first: date, last: date) -> list[FocusSessionOut]:
        rows = await self._pool.fetch(SELECT_FOCUS_SESSIONS, first, last)
        return [FocusSessionOut(**dict(r)) for r in rows]

    async def breath_sessions(self, first: date, last: date) -> list[BreathSessionOut]:
        rows = await self._pool.fetch(SELECT_BREATH_SESSIONS, first, last)
        return [BreathSessionOut(**dict(r)) for r in rows]
