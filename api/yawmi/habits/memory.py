"""In-memory `HabitStore` and `MirrorReader`: for tests and local experiments, never production.

They apply the same filters and ordering as the SQL in `yawmi.habits.store`, so the same API
tests run against both.
"""

from dataclasses import dataclass, field, replace
from datetime import date
from decimal import Decimal

from yawmi.habits.store import CardRef, MilestoneRef, StoredHabit
from yawmi.today.reader import LogRow


def _ordered(habit: StoredHabit) -> StoredHabit:
    reminders = sorted(habit.reminders, key=lambda r: (r.at_time, r.weekday_mask))
    return replace(habit, reminders=tuple(reminders))


@dataclass
class InMemoryHabitStore:
    habits: dict[str, StoredHabit] = field(default_factory=dict)
    log_rows: list[LogRow] = field(default_factory=list)

    async def list_habits(self) -> list[StoredHabit]:
        return [_ordered(self.habits[code]) for code in sorted(self.habits)]

    async def get(self, code: str) -> StoredHabit | None:
        habit = self.habits.get(code)
        return None if habit is None else _ordered(habit)

    async def insert(self, habit: StoredHabit) -> bool:
        if habit.code in self.habits:
            return False
        self.habits[habit.code] = habit
        return True

    async def update(self, habit: StoredHabit, *, replace_reminders: bool) -> None:
        if not replace_reminders:
            habit = replace(habit, reminders=self.habits[habit.code].reminders)
        self.habits[habit.code] = habit

    async def logs(self, code: str, first: date, last: date) -> list[LogRow]:
        return [log for log in self.log_rows if log.habit_code == code and first <= log.day <= last]


@dataclass
class InMemoryMirrorReader:
    milestones: dict[str, MilestoneRef] = field(default_factory=dict)
    cards: dict[str, CardRef] = field(default_factory=dict)
    deadlines: dict[str, date] = field(default_factory=dict)
    kpi_targets: dict[str, Decimal | None] = field(default_factory=dict)
    readings: dict[str, list[tuple[date, Decimal]]] = field(default_factory=dict)

    async def milestone(self, page_id: str) -> MilestoneRef | None:
        return self.milestones.get(page_id)

    async def card(self, page_id: str) -> CardRef | None:
        return self.cards.get(page_id)

    async def outcome_deadline(self, code: str) -> date | None:
        return self.deadlines.get(code)

    async def kpi_target(self, code: str) -> Decimal | None:
        return self.kpi_targets.get(code)

    async def latest_reading(self, code: str, today: date) -> Decimal | None:
        past = [(day, value) for day, value in self.readings.get(code, []) if day <= today]
        return max(past, key=lambda r: r[0])[1] if past else None
