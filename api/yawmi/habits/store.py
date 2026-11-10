"""Habit persistence and the mirror reads of goal-to-habit: contracts and Postgres.

`HabitStore` reads and writes `yawmi.habits` and `yawmi.habit_reminders`, and reads
`yawmi.habit_logs`. Nothing is ever deleted (the role has no DELETE there): a habit is archived
with `active = false`.

Reminders keep their identity. A reminder is its `(at_time, weekday_mask)`: when an edit sends
the reminders again, a reminder that is still there keeps its row (and its id, which the push
service records in `reminder_sends` to never send twice), a removed one is deactivated, and only
a new one gets a new row. So saving a habit with the same reminders touches no reminder row.

An edit (`modify`) locks the habit row (`SELECT … FOR UPDATE`) for the whole read-merge-write,
so two devices editing at once cannot restore each other's stale values. `system` and
`created_by` are never rewritten by an edit.

`MirrorReader` reads the Raqib mirror for `POST /v1/goals/{ref}/to-habit`. Every query names its
columns: `yawmi_api` reads `raqib.notion_cards` and `raqib.kpi_readings` through column-level
grants that leave out `props` and `note` (a test guards the SQL in `ALL_SQL`).

Rows are stored as the table holds them (`unit` and `anchor` may be NULL); the API shape lives in
`yawmi.habits.models`.
"""

import json
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, time
from decimal import Decimal
from typing import Protocol
from uuid import UUID, uuid4

import asyncpg

from yawmi.today.reader import LogRow


@dataclass(frozen=True, order=True)
class Reminder:
    at_time: time
    weekday_mask: int


@dataclass(frozen=True)
class StoredHabit:
    """A `yawmi.habits` row (column names) with its active reminders, sorted."""

    code: str
    title_ar: str
    goal_ref: str | None
    outcome: str | None
    ac_ref: str | None
    kind: str
    unit: str | None
    target_per_period: Decimal
    period: str
    schedule_kind: str
    weekday_mask: int | None
    every_n: int | None
    anchor_day: date | None
    anchor: str | None
    start_day: date
    end_day: date | None
    system: bool
    created_by: str
    active: bool
    reminders: tuple[Reminder, ...] = field(default=())


Change = Callable[[StoredHabit], StoredHabit]


class HabitStore(Protocol):
    async def list_habits(self) -> list[StoredHabit]:
        """Every habit, archived ones included, by code."""
        ...

    async def get(self, code: str) -> StoredHabit | None: ...

    async def insert(self, habit: StoredHabit) -> bool:
        """Insert the habit and its reminders; `False` (and nothing written) if the code exists."""
        ...

    async def modify(self, code: str, change: Change) -> StoredHabit | None:
        """Lock the habit, store `change(habit)`, and return it; `None` if there is no such habit.

        An exception raised by `change` aborts the edit with nothing written. Columns other than
        `code`, `system` and `created_by` are overwritten; reminders are reconciled by
        `(at_time, weekday_mask)` (see the module docstring).
        """
        ...

    async def logs(self, code: str, first: date, last: date) -> list[LogRow]:
        """The habit's logs, of every source, with `day` in `[first, last]`."""
        ...


def reconcile(
    current: Sequence[tuple[UUID, Reminder]], wanted: Iterable[Reminder]
) -> tuple[list[UUID], list[Reminder]]:
    """Which active reminder rows to deactivate and which reminders to insert.

    A row whose reminder is still wanted is kept (the first one, if the same reminder has more
    than one active row); every other row is deactivated; a wanted reminder with no row is new.
    """
    target = set(wanted)
    kept: set[Reminder] = set()
    deactivate: list[UUID] = []
    for row_id, reminder in current:
        if reminder in target and reminder not in kept:
            kept.add(reminder)
        else:
            deactivate.append(row_id)
    return deactivate, sorted(target - kept)


@dataclass(frozen=True)
class MilestoneRef:
    title: str
    outcome_code: str | None
    due_date: date | None


@dataclass(frozen=True)
class CardRef:
    title: str
    outcome_codes: tuple[str, ...]


@dataclass(frozen=True)
class KpiRef:
    target: Decimal | None  # None: the KPI has no single target (a range, or nothing)


class MirrorReader(Protocol):
    async def milestone(self, page_id: str) -> MilestoneRef | None: ...

    async def card(self, page_id: str) -> CardRef | None: ...

    async def outcome_deadline(self, code: str) -> date | None:
        """`raqib.goals.target_date` of an outcome, or `None` if unknown."""
        ...

    async def kpi(self, code: str) -> KpiRef | None:
        """The KPI of `raqib.kpis`, or `None` if there is no KPI with that code."""
        ...

    async def latest_reading(self, code: str, today: date) -> Decimal | None:
        """The newest reading of the KPI on or before `today`, or `None`."""
        ...


HABIT_COLUMNS = (
    "code",
    "title_ar",
    "goal_ref",
    "outcome",
    "ac_ref",
    "kind",
    "unit",
    "target_per_period",
    "period",
    "schedule_kind",
    "weekday_mask",
    "every_n",
    "anchor_day",
    "anchor",
    "start_day",
    "end_day",
    "system",
    "created_by",
    "active",
)
# what an edit may write: never the code, nor who made the habit and whether it is a system one
EDITED_COLUMNS = tuple(c for c in HABIT_COLUMNS if c not in ("code", "system", "created_by"))
_SELECT = ", ".join(HABIT_COLUMNS)

LIST_HABITS = f"SELECT {_SELECT} FROM yawmi.habits ORDER BY code"
GET_HABIT = f"SELECT {_SELECT} FROM yawmi.habits WHERE code = $1"
LOCK_HABIT = f"SELECT {_SELECT} FROM yawmi.habits WHERE code = $1 FOR UPDATE"
INSERT_HABIT = (
    f"INSERT INTO yawmi.habits ({_SELECT}) VALUES "
    f"({', '.join(f'${i}' for i in range(1, len(HABIT_COLUMNS) + 1))}) "
    "ON CONFLICT (code) DO NOTHING RETURNING code"
)
UPDATE_HABIT = (
    "UPDATE yawmi.habits SET "
    + ", ".join(f"{column} = ${i}" for i, column in enumerate(EDITED_COLUMNS, start=2))
    + ", updated_at = now() WHERE code = $1"
)
REMINDERS = """
SELECT id, habit_code, at_time, weekday_mask
FROM yawmi.habit_reminders
WHERE active AND habit_code = ANY($1)
ORDER BY habit_code, at_time, weekday_mask, id
"""
DEACTIVATE_REMINDERS = """
UPDATE yawmi.habit_reminders SET active = FALSE WHERE id = ANY($1)
"""
INSERT_REMINDER = """
INSERT INTO yawmi.habit_reminders (id, habit_code, at_time, weekday_mask) VALUES ($1, $2, $3, $4)
"""
LOGS = """
SELECT habit_code, day, value, status
FROM yawmi.habit_logs
WHERE habit_code = $1 AND day BETWEEN $2 AND $3
"""

MILESTONE = """
SELECT title, outcome_code, due_date FROM raqib.notion_milestones WHERE page_id = $1
"""
# column-level grant: never `props`
CARD = "SELECT title, outcome_codes FROM raqib.notion_cards WHERE page_id = $1"
OUTCOME_DEADLINE = "SELECT target_date FROM raqib.goals WHERE code = $1"
KPI = "SELECT target FROM raqib.kpis WHERE code = $1"
# column-level grant: never `note`
LATEST_READING = """
SELECT value
FROM raqib.kpi_readings
WHERE kpi_code = $1 AND reading_date <= $2
ORDER BY reading_date DESC, created_at DESC, id DESC
LIMIT 1
"""

ALL_SQL = (
    LIST_HABITS,
    GET_HABIT,
    LOCK_HABIT,
    INSERT_HABIT,
    UPDATE_HABIT,
    REMINDERS,
    DEACTIVATE_REMINDERS,
    INSERT_REMINDER,
    LOGS,
    MILESTONE,
    CARD,
    OUTCOME_DEADLINE,
    KPI,
    LATEST_READING,
)


def _values(habit: StoredHabit, columns: Sequence[str]) -> list[object]:
    return [getattr(habit, column) for column in columns]


async def _reminder_rows(
    conn: asyncpg.Pool | asyncpg.Connection, codes: list[str]
) -> dict[str, list[tuple[UUID, Reminder]]]:
    by_code: dict[str, list[tuple[UUID, Reminder]]] = {}
    for r in await conn.fetch(REMINDERS, codes) if codes else []:
        by_code.setdefault(r["habit_code"], []).append(
            (r["id"], Reminder(r["at_time"], r["weekday_mask"]))
        )
    return by_code


def _habit(row: asyncpg.Record, reminders: Iterable[tuple[UUID, Reminder]]) -> StoredHabit:
    return StoredHabit(**dict(row), reminders=tuple(sorted({r for _, r in reminders})))


class AsyncpgHabitStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list_habits(self) -> list[StoredHabit]:
        rows = await self._pool.fetch(LIST_HABITS)
        by_code = await _reminder_rows(self._pool, [r["code"] for r in rows])
        return [_habit(r, by_code.get(r["code"], [])) for r in rows]

    async def get(self, code: str) -> StoredHabit | None:
        row = await self._pool.fetchrow(GET_HABIT, code)
        if row is None:
            return None
        return _habit(row, (await _reminder_rows(self._pool, [code])).get(code, []))

    async def insert(self, habit: StoredHabit) -> bool:
        async with self._pool.acquire() as conn, conn.transaction():
            if await conn.fetchval(INSERT_HABIT, *_values(habit, HABIT_COLUMNS)) is None:
                return False
            for reminder in sorted(set(habit.reminders)):
                await conn.execute(
                    INSERT_REMINDER, uuid4(), habit.code, reminder.at_time, reminder.weekday_mask
                )
        return True

    async def modify(self, code: str, change: Change) -> StoredHabit | None:
        async with self._pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(LOCK_HABIT, code)
            if row is None:
                return None
            current = (await _reminder_rows(conn, [code])).get(code, [])
            habit = change(_habit(row, current))
            await conn.execute(UPDATE_HABIT, code, *_values(habit, EDITED_COLUMNS))
            deactivate, new = reconcile(current, habit.reminders)
            if deactivate:
                await conn.execute(DEACTIVATE_REMINDERS, deactivate)
            for reminder in new:
                await conn.execute(
                    INSERT_REMINDER, uuid4(), code, reminder.at_time, reminder.weekday_mask
                )
        return await self.get(code)

    async def logs(self, code: str, first: date, last: date) -> list[LogRow]:
        return [LogRow(**dict(r)) for r in await self._pool.fetch(LOGS, code, first, last)]


def _codes(raw: object) -> tuple[str, ...]:
    """`outcome_codes` is `jsonb`: asyncpg returns its text unless a codec is set."""
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(value, list):
        return ()
    return tuple(str(code) for code in value)


class AsyncpgMirrorReader:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def milestone(self, page_id: str) -> MilestoneRef | None:
        row = await self._pool.fetchrow(MILESTONE, page_id)
        return None if row is None else MilestoneRef(**dict(row))

    async def card(self, page_id: str) -> CardRef | None:
        row = await self._pool.fetchrow(CARD, page_id)
        return None if row is None else CardRef(row["title"], _codes(row["outcome_codes"]))

    async def outcome_deadline(self, code: str) -> date | None:
        return await self._pool.fetchval(OUTCOME_DEADLINE, code)

    async def kpi(self, code: str) -> KpiRef | None:
        row = await self._pool.fetchrow(KPI, code)
        return None if row is None else KpiRef(row["target"])

    async def latest_reading(self, code: str, today: date) -> Decimal | None:
        return await self._pool.fetchval(LATEST_READING, code, today)
