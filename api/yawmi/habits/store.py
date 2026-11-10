"""Habit persistence and the mirror reads of goal-to-habit: contracts and Postgres.

`HabitStore` reads and writes `yawmi.habits` and `yawmi.habit_reminders`, and reads
`yawmi.habit_logs`. Nothing is ever deleted (the role has no DELETE there): a habit is archived
with `active = false`, and replacing a habit's reminders deactivates the old rows and inserts new
ones.

`MirrorReader` reads the Raqib mirror for `POST /v1/goals/{ref}/to-habit`. Every query names its
columns: `yawmi_api` reads `raqib.notion_cards` and `raqib.kpi_readings` through column-level
grants that leave out `props` and `note` (a test guards the SQL in `ALL_SQL`).

Rows are stored as the table holds them (`unit` and `anchor` may be NULL); the API shape lives in
`yawmi.habits.models`.
"""

import json
from dataclasses import dataclass, field
from datetime import date, time
from decimal import Decimal
from typing import Protocol
from uuid import uuid4

import asyncpg

from yawmi.today.reader import LogRow


@dataclass(frozen=True)
class Reminder:
    at_time: time
    weekday_mask: int


@dataclass(frozen=True)
class StoredHabit:
    """A `yawmi.habits` row (column names) with its active reminders."""

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


class HabitStore(Protocol):
    async def list_habits(self) -> list[StoredHabit]:
        """Every habit, archived ones included, by code."""
        ...

    async def get(self, code: str) -> StoredHabit | None: ...

    async def insert(self, habit: StoredHabit) -> bool:
        """Insert the habit and its reminders; `False` (and nothing written) if the code exists."""
        ...

    async def update(self, habit: StoredHabit, *, replace_reminders: bool) -> None:
        """Overwrite the habit's columns; with `replace_reminders`, swap its active reminders."""
        ...

    async def logs(self, code: str, first: date, last: date) -> list[LogRow]:
        """The habit's logs, of every source, with `day` in `[first, last]`."""
        ...


@dataclass(frozen=True)
class MilestoneRef:
    title: str
    outcome_code: str | None
    due_date: date | None


@dataclass(frozen=True)
class CardRef:
    title: str
    outcome_codes: tuple[str, ...]


class MirrorReader(Protocol):
    async def milestone(self, page_id: str) -> MilestoneRef | None: ...

    async def card(self, page_id: str) -> CardRef | None: ...

    async def outcome_deadline(self, code: str) -> date | None:
        """`raqib.goals.target_date` of an outcome, or `None` if unknown."""
        ...

    async def kpi_target(self, code: str) -> Decimal | None:
        """`raqib.kpis.target`, or `None` if the KPI is unknown or has no single target."""
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
_SELECT = ", ".join(HABIT_COLUMNS)

LIST_HABITS = f"SELECT {_SELECT} FROM yawmi.habits ORDER BY code"
GET_HABIT = f"SELECT {_SELECT} FROM yawmi.habits WHERE code = $1"
INSERT_HABIT = (
    f"INSERT INTO yawmi.habits ({_SELECT}) VALUES "
    f"({', '.join(f'${i}' for i in range(1, len(HABIT_COLUMNS) + 1))}) "
    "ON CONFLICT (code) DO NOTHING RETURNING code"
)
_UPDATED = HABIT_COLUMNS[1:]
UPDATE_HABIT = (
    "UPDATE yawmi.habits SET "
    + ", ".join(f"{column} = ${i}" for i, column in enumerate(_UPDATED, start=2))
    + ", updated_at = now() WHERE code = $1"
)
REMINDERS = """
SELECT habit_code, at_time, weekday_mask
FROM yawmi.habit_reminders
WHERE active AND habit_code = ANY($1)
ORDER BY habit_code, at_time, weekday_mask
"""
DEACTIVATE_REMINDERS = """
UPDATE yawmi.habit_reminders SET active = FALSE WHERE habit_code = $1 AND active
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
KPI_TARGET = "SELECT target FROM raqib.kpis WHERE code = $1"
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
    INSERT_HABIT,
    UPDATE_HABIT,
    REMINDERS,
    DEACTIVATE_REMINDERS,
    INSERT_REMINDER,
    LOGS,
    MILESTONE,
    CARD,
    OUTCOME_DEADLINE,
    KPI_TARGET,
    LATEST_READING,
)


def _values(habit: StoredHabit) -> list[object]:
    return [getattr(habit, column) for column in HABIT_COLUMNS]


class AsyncpgHabitStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def _with_reminders(self, rows: list[asyncpg.Record]) -> list[StoredHabit]:
        codes = [r["code"] for r in rows]
        by_code: dict[str, list[Reminder]] = {}
        for r in await self._pool.fetch(REMINDERS, codes) if codes else []:
            by_code.setdefault(r["habit_code"], []).append(
                Reminder(r["at_time"], r["weekday_mask"])
            )
        return [StoredHabit(**dict(r), reminders=tuple(by_code.get(r["code"], ()))) for r in rows]

    async def list_habits(self) -> list[StoredHabit]:
        return await self._with_reminders(await self._pool.fetch(LIST_HABITS))

    async def get(self, code: str) -> StoredHabit | None:
        row = await self._pool.fetchrow(GET_HABIT, code)
        return None if row is None else (await self._with_reminders([row]))[0]

    async def insert(self, habit: StoredHabit) -> bool:
        async with self._pool.acquire() as conn, conn.transaction():
            if await conn.fetchval(INSERT_HABIT, *_values(habit)) is None:
                return False
            for reminder in habit.reminders:
                await conn.execute(
                    INSERT_REMINDER, uuid4(), habit.code, reminder.at_time, reminder.weekday_mask
                )
        return True

    async def update(self, habit: StoredHabit, *, replace_reminders: bool) -> None:
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(UPDATE_HABIT, *_values(habit))
            if replace_reminders:
                await conn.execute(DEACTIVATE_REMINDERS, habit.code)
                for reminder in habit.reminders:
                    await conn.execute(
                        INSERT_REMINDER,
                        uuid4(),
                        habit.code,
                        reminder.at_time,
                        reminder.weekday_mask,
                    )

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

    async def kpi_target(self, code: str) -> Decimal | None:
        return await self._pool.fetchval(KPI_TARGET, code)

    async def latest_reading(self, code: str, today: date) -> Decimal | None:
        return await self._pool.fetchval(LATEST_READING, code, today)
