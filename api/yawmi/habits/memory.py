"""In-memory `HabitStore` and `MirrorReader`: for tests and local experiments, never production.

They apply the same filters, ordering and reminder reconciliation as `yawmi.habits.store`, so
the same API tests run against both. Reminder rows are kept as the table keeps them (with an id
and an `active` flag) so tests can check that an edit keeps a reminder's identity.
"""

from dataclasses import dataclass, field, replace
from datetime import date, time
from decimal import Decimal
from uuid import UUID, uuid4

from yawmi.habits.store import (
    CardRef,
    Change,
    KpiRef,
    MilestoneRef,
    Reminder,
    StoredHabit,
    reconcile,
)
from yawmi.today.reader import LogRow


@dataclass
class ReminderRow:
    id: UUID
    habit_code: str
    at_time: time
    weekday_mask: int
    active: bool = True


@dataclass
class InMemoryHabitStore:
    habits: dict[str, StoredHabit] = field(default_factory=dict)  # their `reminders` are unused
    reminder_rows: list[ReminderRow] = field(default_factory=list)
    log_rows: list[LogRow] = field(default_factory=list)

    def _active(self, code: str) -> list[tuple[UUID, Reminder]]:
        rows = [r for r in self.reminder_rows if r.habit_code == code and r.active]
        rows.sort(key=lambda r: (r.at_time, r.weekday_mask, r.id))
        return [(r.id, Reminder(r.at_time, r.weekday_mask)) for r in rows]

    def _with_reminders(self, code: str) -> StoredHabit:
        reminders = tuple(sorted({r for _, r in self._active(code)}))
        return replace(self.habits[code], reminders=reminders)

    def _add(self, code: str, reminders: list[Reminder]) -> None:
        for r in reminders:
            self.reminder_rows.append(ReminderRow(uuid4(), code, r.at_time, r.weekday_mask))

    async def list_habits(self) -> list[StoredHabit]:
        return [self._with_reminders(code) for code in sorted(self.habits)]

    async def get(self, code: str) -> StoredHabit | None:
        return self._with_reminders(code) if code in self.habits else None

    async def insert(self, habit: StoredHabit) -> bool:
        if habit.code in self.habits:
            return False
        self.habits[habit.code] = habit
        self._add(habit.code, sorted(set(habit.reminders)))
        return True

    async def modify(self, code: str, change: Change) -> StoredHabit | None:
        if code not in self.habits:
            return None
        current = self._active(code)
        stored = self._with_reminders(code)
        habit = change(stored)
        self.habits[code] = replace(
            habit, code=code, system=stored.system, created_by=stored.created_by
        )
        deactivate, new = reconcile(current, habit.reminders)
        for row in self.reminder_rows:
            if row.id in deactivate:
                row.active = False
        self._add(code, new)
        return self._with_reminders(code)

    async def logs(self, code: str, first: date, last: date) -> list[LogRow]:
        return [log for log in self.log_rows if log.habit_code == code and first <= log.day <= last]


@dataclass
class InMemoryMirrorReader:
    milestones: dict[str, MilestoneRef] = field(default_factory=dict)
    cards: dict[str, CardRef] = field(default_factory=dict)
    deadlines: dict[str, date] = field(default_factory=dict)
    kpis: dict[str, KpiRef] = field(default_factory=dict)  # key = a known KPI
    readings: dict[str, list[tuple[date, Decimal]]] = field(default_factory=dict)

    async def milestone(self, page_id: str) -> MilestoneRef | None:
        return self.milestones.get(page_id)

    async def card(self, page_id: str) -> CardRef | None:
        return self.cards.get(page_id)

    async def outcome_deadline(self, code: str) -> date | None:
        return self.deadlines.get(code)

    async def kpi(self, code: str) -> KpiRef | None:
        return self.kpis.get(code)

    async def latest_reading(self, code: str, today: date) -> Decimal | None:
        past = [(day, value) for day, value in self.readings.get(code, []) if day <= today]
        return max(past, key=lambda r: r[0])[1] if past else None
