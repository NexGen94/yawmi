"""In-memory `TodayReader`: for tests and local experiments, never for production.

It applies the same filters as the SQL in `yawmi.today.reader`, so the same API tests can run
against both.
"""

from dataclasses import dataclass, field
from datetime import date

from yawmi.today.reader import (
    CardRow,
    CycleRow,
    GoalRow,
    HabitRow,
    LogRow,
    MetricsRow,
    MilestoneRow,
)


@dataclass
class InMemoryTodayReader:
    habits: list[HabitRow] = field(default_factory=list)
    inactive: set[str] = field(default_factory=set)  # codes archived with `active = false`
    logs: list[LogRow] = field(default_factory=list)
    metrics: list[MetricsRow] = field(default_factory=list)
    cycle_rows: list[CycleRow] = field(default_factory=list)
    milestone_rows: list[MilestoneRow] = field(default_factory=list)
    goal_rows: list[GoalRow] = field(default_factory=list)
    card_rows: list[CardRow] = field(default_factory=list)

    async def active_habits(self, day: date) -> list[HabitRow]:
        return sorted(
            (
                h
                for h in self.habits
                if h.code not in self.inactive
                and h.start_day <= day
                and (h.end_day is None or h.end_day >= day)
            ),
            key=lambda h: h.code,
        )

    async def habit_logs(self, first: date, last: date) -> list[LogRow]:
        return [log for log in self.logs if first <= log.day <= last]

    async def daily_metrics(self, first: date, last: date) -> list[MetricsRow]:
        return sorted((m for m in self.metrics if first <= m.day <= last), key=lambda m: m.day)

    async def cycles(self) -> list[CycleRow]:
        return sorted(self.cycle_rows, key=lambda c: c.cycle_no)

    async def milestones(self) -> list[MilestoneRow]:
        return list(self.milestone_rows)

    async def goals(self) -> list[GoalRow]:
        return list(self.goal_rows)

    async def cards(self) -> list[CardRow]:
        return list(self.card_rows)
