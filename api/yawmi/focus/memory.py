"""In-memory focus store for tests.

Its sessions are what the in-memory event store projected (when given), plus any added directly.
"""

from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

from yawmi.events.memory_store import InMemoryEventStore
from yawmi.focus.models import (
    BreathSessionOut,
    FocusPlanIO,
    FocusPlanOut,
    FocusSessionOut,
)
from yawmi.focus.store import UnknownHabit


class InMemoryFocusStore:
    def __init__(self, *, events: InMemoryEventStore | None = None) -> None:
        self.events = events
        self.items: dict[UUID, FocusPlanOut] = {}
        self._order: dict[UUID, int] = {}  # the last write of each plan: newest first
        self._clock = 0
        self.session_rows: list[FocusSessionOut] = []
        self.started_events: list[datetime] = []

    def _check_habit(self, code: str | None) -> None:
        if code is not None and self.events is not None and code not in self.events.habits:
            raise UnknownHabit(code)

    def _touch(self, plan: FocusPlanOut) -> FocusPlanOut:
        self._clock += 1
        self._order[plan.id] = self._clock
        self.items[plan.id] = plan
        return plan

    async def plans(self, include_inactive: bool = False) -> list[FocusPlanOut]:
        shown = [p for p in self.items.values() if include_inactive or p.active]
        return sorted(shown, key=lambda p: (not p.favorite, -self._order[p.id]))

    async def add_plan(self, p: FocusPlanIO) -> FocusPlanOut:
        self._check_habit(p.habit_code)
        out = FocusPlanOut(**p.model_dump(), id=uuid4(), updated_at=datetime.now(UTC))
        return self._touch(out)

    async def patch_plan(self, id: UUID, changes: dict[str, Any]) -> FocusPlanOut | None:
        current = self.items.get(id)
        if current is None:
            return None
        merged = {**current.model_dump(), **changes}
        self._check_habit(merged["habit_code"])
        out = FocusPlanOut.model_validate({**merged, "updated_at": datetime.now(UTC)})
        return self._touch(out)

    def add_session(self, id: UUID, day: date, started_at: datetime) -> None:
        """A focus session that began at `started_at` (a test helper)."""
        self.session_rows.append(
            FocusSessionOut(
                id=id,
                day=day,
                started_at=started_at,
                ended_at=started_at,
                planned_minutes=25,
                actual_minutes=25.0,
                goal_ref=None,
                habit_code=None,
                focus_rating=None,
                next_step=None,
            )
        )

    async def sessions(self, first: date, last: date) -> list[FocusSessionOut]:
        rows = [r for r in self.session_rows if first <= r.day <= last]
        if self.events is not None:
            rows += [
                FocusSessionOut(
                    id=s.event_id,
                    day=s.day,
                    started_at=s.started_at,
                    ended_at=s.ended_at,
                    planned_minutes=s.planned_minutes,
                    actual_minutes=float(s.actual_minutes)
                    if s.actual_minutes is not None
                    else None,
                    goal_ref=s.goal_ref,
                    habit_code=s.habit_code,
                    focus_rating=s.focus_rating,
                    next_step=s.next_step,
                )
                for s in self.events.focus_sessions
                if first <= s.day <= last
            ]
        return sorted(rows, key=lambda r: (r.started_at, str(r.id)))

    async def breath_sessions(self, first: date, last: date) -> list[BreathSessionOut]:
        if self.events is None:
            return []
        rows = [
            BreathSessionOut(
                id=s.event_id,
                day=s.day,
                started_at=s.started_at,
                ended_at=s.ended_at,
                pattern=s.pattern,
                breaths_per_min=float(s.breaths_per_min) if s.breaths_per_min is not None else None,
                duration_seconds=s.duration_seconds,
                completed=s.completed,
                feeling=s.feeling,  # type: ignore[arg-type]
            )
            for s in self.events.breath_sessions
            if first <= s.day <= last
        ]
        return sorted(rows, key=lambda r: (r.started_at, str(r.id)))

    def add_started_event(self, id: UUID, at: datetime) -> None:
        """A `focus_started` event with no `focus_ended` after it (a test helper)."""
        self.started_events.append(at)

    async def started_between(self, lo: datetime, hi: datetime) -> bool:
        starts = [r.started_at for r in self.session_rows] + self.started_events
        if self.events is not None:
            starts += [s.started_at for s in self.events.focus_sessions]
            starts += [
                e.occurred_at for e in self.events.events.values() if e.type == "focus_started"
            ]
        return any(lo <= t <= hi for t in starts)
