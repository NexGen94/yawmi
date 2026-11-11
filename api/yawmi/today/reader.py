"""What `/v1/today` and `/v1/overview` read: row types, the `TodayReader` contract, Postgres.

Every query names its columns. `yawmi_api` reads `raqib.notion_cards` and `raqib.kpi_readings`
through column-level grants that leave out `props` and `note` (personal free text), so a
`SELECT *` there is denied, and those two columns are never read (a test guards the SQL).
Column names are the mirror's own (`api/db/migrations/0002_yawmi_role.sql`, and the stub in
`api/tests/fixtures/raqib_stub.sql`).

The reader returns plain rows and decides nothing: which habit is due, which cycle is current
and what an outcome's completion is are decided in `yawmi.today.assemble`, without a database.
"""

import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol

import asyncpg

from yawmi.domain.scores import DataQuality


@dataclass(frozen=True)
class HabitRow:
    code: str
    title_ar: str
    kind: str
    unit: str | None
    target_per_period: Decimal
    period: str
    schedule_kind: str
    weekday_mask: int | None
    every_n: int | None
    anchor_day: date | None
    start_day: date
    end_day: date | None
    goal_ref: str | None = None


@dataclass(frozen=True)
class LogRow:
    habit_code: str
    day: date
    value: Decimal | None
    status: str | None


@dataclass(frozen=True)
class MetricsRow:
    day: date
    recovery_score: int | None
    strain_score: Decimal | None
    sleep_minutes: int | None
    data_quality: DataQuality


@dataclass(frozen=True)
class CycleRow:
    cycle_no: int
    start_date: date
    end_date: date
    review_end: date


@dataclass(frozen=True)
class MilestoneRow:
    page_id: str
    title: str
    outcome_code: str | None
    cycle_no: int | None
    due_date: date | None
    done: bool


@dataclass(frozen=True)
class GoalRow:
    code: str
    title: str
    target_date: date
    status: str


@dataclass(frozen=True)
class CardRow:
    page_id: str
    title: str
    status: str | None
    outcome_codes: tuple[str, ...]


class TodayReader(Protocol):
    async def active_habits(self, day: date) -> list[HabitRow]:
        """Active habits whose window `[start_day, end_day]` contains `day`, by code."""
        ...

    async def habit_logs(self, first: date, last: date) -> list[LogRow]:
        """Habit logs with `day` in `[first, last]`: at most one per habit and day (I-10)."""
        ...

    async def linked_habits(self) -> list[HabitRow]:
        """Active habits that serve a goal (`goal_ref` set), whatever their window, by code."""
        ...

    async def habit_logs_of(self, codes: list[str], first: date, last: date) -> list[LogRow]:
        """Logs of the habits `codes` only, with `day` in `[first, last]`, one per day."""
        ...

    async def daily_metrics(self, first: date, last: date) -> list[MetricsRow]:
        """Stored health days in `[first, last]`, oldest first."""
        ...

    async def cycles(self) -> list[CycleRow]: ...

    async def milestones(self) -> list[MilestoneRow]: ...

    async def goals(self) -> list[GoalRow]: ...

    async def cards(self) -> list[CardRow]: ...


ACTIVE_HABITS = """
SELECT code, title_ar, kind, unit, target_per_period, period, schedule_kind,
       weekday_mask, every_n, anchor_day, start_day, end_day, goal_ref
FROM yawmi.habits
WHERE active AND start_day <= $1 AND (end_day IS NULL OR end_day >= $1)
ORDER BY code
"""

LINKED_HABITS = """
SELECT code, title_ar, kind, unit, target_per_period, period, schedule_kind,
       weekday_mask, every_n, anchor_day, start_day, end_day, goal_ref
FROM yawmi.habits
WHERE active AND goal_ref IS NOT NULL
ORDER BY code
"""

HABIT_LOGS = """
SELECT habit_code, day, value, status
FROM yawmi.habit_logs
WHERE day BETWEEN $1 AND $2
"""

HABIT_LOGS_OF = """
SELECT habit_code, day, value, status
FROM yawmi.habit_logs
WHERE habit_code = ANY($1) AND day BETWEEN $2 AND $3
"""

DAILY_METRICS = """
SELECT day, recovery_score, strain_score, sleep_minutes, data_quality
FROM yawmi.daily_metrics
WHERE day BETWEEN $1 AND $2
ORDER BY day
"""

CYCLES = """
SELECT cycle_no, start_date, end_date, review_end
FROM raqib.cycles
ORDER BY cycle_no
"""

MILESTONES = """
SELECT page_id, title, outcome_code, cycle_no, due_date, done
FROM raqib.notion_milestones
"""

GOALS = """
SELECT code, title, target_date, status
FROM raqib.goals
"""

# column-level grant: never `props`
CARDS = """
SELECT page_id, title, status, outcome_codes
FROM raqib.notion_cards
"""

ALL_SQL = (
    ACTIVE_HABITS,
    LINKED_HABITS,
    HABIT_LOGS,
    HABIT_LOGS_OF,
    DAILY_METRICS,
    CYCLES,
    MILESTONES,
    GOALS,
    CARDS,
)


def _codes(raw: object) -> tuple[str, ...]:
    """`outcome_codes` is `jsonb`: asyncpg returns its text unless a codec is set."""
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(value, list):
        return ()
    return tuple(str(code) for code in value)


class AsyncpgTodayReader:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def active_habits(self, day: date) -> list[HabitRow]:
        return [HabitRow(**dict(r)) for r in await self._pool.fetch(ACTIVE_HABITS, day)]

    async def habit_logs(self, first: date, last: date) -> list[LogRow]:
        return [LogRow(**dict(r)) for r in await self._pool.fetch(HABIT_LOGS, first, last)]

    async def linked_habits(self) -> list[HabitRow]:
        return [HabitRow(**dict(r)) for r in await self._pool.fetch(LINKED_HABITS)]

    async def habit_logs_of(self, codes: list[str], first: date, last: date) -> list[LogRow]:
        rows = await self._pool.fetch(HABIT_LOGS_OF, codes, first, last)
        return [LogRow(**dict(r)) for r in rows]

    async def daily_metrics(self, first: date, last: date) -> list[MetricsRow]:
        return [MetricsRow(**dict(r)) for r in await self._pool.fetch(DAILY_METRICS, first, last)]

    async def cycles(self) -> list[CycleRow]:
        return [CycleRow(**dict(r)) for r in await self._pool.fetch(CYCLES)]

    async def milestones(self) -> list[MilestoneRow]:
        return [MilestoneRow(**dict(r)) for r in await self._pool.fetch(MILESTONES)]

    async def goals(self) -> list[GoalRow]:
        return [GoalRow(**dict(r)) for r in await self._pool.fetch(GOALS)]

    async def cards(self) -> list[CardRow]:
        rows = await self._pool.fetch(CARDS)
        return [
            CardRow(
                page_id=r["page_id"],
                title=r["title"],
                status=r["status"],
                outcome_codes=_codes(r["outcome_codes"]),
            )
            for r in rows
        ]
