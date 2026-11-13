"""What the AI grounding reads (design §10, I-7): the `GroundingReader` contract and its stores.

The grounding reads stored rows only: habits and their logs, the journal and mood, focus and
breath days, and the mirror with the goal edits laid over it (the milestones the user sees, as in
`GET /v1/today`). `StoreGroundingReader` composes the readers the other routes already use; the
focus and breath day totals are read here (their SQL are named constants, planned as `yawmi_api`
by `test_migrations`). Nothing here reads `daily_metrics`: no health number reaches a provider.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol

import asyncpg

from yawmi.goals.assemble import overlay
from yawmi.goals.edits_store import EditStore
from yawmi.goals.service import current_edits
from yawmi.journal.store import JournalReader, JournalRow, MoodRow
from yawmi.today.reader import CycleRow, GoalRow, HabitRow, LogRow, MilestoneRow, TodayReader


@dataclass(frozen=True)
class SessionDay:
    """The focus or breath sessions of one day: how many, and their minutes together."""

    day: date
    sessions: int
    minutes: float


class SessionReader(Protocol):
    async def focus_days(self, first: date, last: date) -> list[SessionDay]: ...

    async def breath_days(self, first: date, last: date) -> list[SessionDay]: ...


class GroundingReader(Protocol):
    async def habits(self, day: date) -> list[HabitRow]:
        """The habits active on `day`, by code."""
        ...

    async def habit_logs(self, first: date, last: date) -> list[LogRow]: ...

    async def journal(self, first: date, last: date) -> list[JournalRow]: ...

    async def moods(self, first: date, last: date) -> list[MoodRow]: ...

    async def focus_days(self, first: date, last: date) -> list[SessionDay]: ...

    async def breath_days(self, first: date, last: date) -> list[SessionDay]: ...

    async def milestones(self) -> list[MilestoneRow]:
        """The milestones as shown: the goal edits laid over the mirror."""
        ...

    async def goals(self) -> list[GoalRow]: ...

    async def cycles(self) -> list[CycleRow]: ...


FOCUS_DAYS = """
SELECT day, count(*)::int AS sessions, coalesce(sum(actual_minutes), 0)::float8 AS minutes
FROM yawmi.focus_sessions
WHERE day BETWEEN $1 AND $2
GROUP BY day
ORDER BY day
"""

BREATH_DAYS = """
SELECT day, count(*)::int AS sessions, coalesce(sum(duration_seconds), 0)::float8 / 60 AS minutes
FROM yawmi.breath_sessions
WHERE day BETWEEN $1 AND $2
GROUP BY day
ORDER BY day
"""


class AsyncpgSessionReader:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def _days(self, sql: str, first: date, last: date) -> list[SessionDay]:
        rows = await self._pool.fetch(sql, first, last)
        return [SessionDay(r["day"], r["sessions"], float(r["minutes"])) for r in rows]

    async def focus_days(self, first: date, last: date) -> list[SessionDay]:
        return await self._days(FOCUS_DAYS, first, last)

    async def breath_days(self, first: date, last: date) -> list[SessionDay]:
        return await self._days(BREATH_DAYS, first, last)


@dataclass
class InMemorySessionReader:
    """Day totals given directly (tests and the in-memory end-to-end app)."""

    focus: list[SessionDay] = field(default_factory=list)
    breath: list[SessionDay] = field(default_factory=list)

    @staticmethod
    def _in(rows: Sequence[SessionDay], first: date, last: date) -> list[SessionDay]:
        totals: dict[date, SessionDay] = {}
        for r in rows:
            if first <= r.day <= last:
                seen = totals.get(r.day)
                totals[r.day] = (
                    r
                    if seen is None
                    else SessionDay(r.day, seen.sessions + r.sessions, seen.minutes + r.minutes)
                )
        return [totals[d] for d in sorted(totals)]

    async def focus_days(self, first: date, last: date) -> list[SessionDay]:
        return self._in(self.focus, first, last)

    async def breath_days(self, first: date, last: date) -> list[SessionDay]:
        return self._in(self.breath, first, last)


class StoreGroundingReader:
    """The grounding reader over the stores the other routes use."""

    def __init__(
        self,
        today: TodayReader,
        journal: JournalReader,
        sessions: SessionReader,
        edits: EditStore | None,
    ) -> None:
        self._today = today
        self._journal = journal
        self._sessions = sessions
        self._edits = edits

    async def habits(self, day: date) -> list[HabitRow]:
        return await self._today.active_habits(day)

    async def habit_logs(self, first: date, last: date) -> list[LogRow]:
        return await self._today.habit_logs(first, last)

    async def journal(self, first: date, last: date) -> list[JournalRow]:
        return await self._journal.entries(first, last)

    async def moods(self, first: date, last: date) -> list[MoodRow]:
        return await self._journal.moods(first, last)

    async def focus_days(self, first: date, last: date) -> list[SessionDay]:
        return await self._sessions.focus_days(first, last)

    async def breath_days(self, first: date, last: date) -> list[SessionDay]:
        return await self._sessions.breath_days(first, last)

    async def milestones(self) -> list[MilestoneRow]:
        shown, _ = overlay(await self._today.milestones(), await current_edits(self._edits))
        return shown

    async def goals(self) -> list[GoalRow]:
        return await self._today.goals()

    async def cycles(self) -> list[CycleRow]:
        return await self._today.cycles()
