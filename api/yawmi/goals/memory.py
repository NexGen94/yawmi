"""In-memory `GoalsReader` and `GoalTaskStore`: for tests and local experiments, never production.

They apply the same rules as the SQL in `yawmi.goals.reader` and `yawmi.goals.tasks_store`, so
the same API tests run against both.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

from yawmi.goals.models import GoalTaskOut
from yawmi.goals.reader import (
    CardFieldsRow,
    CardFullRow,
    CycleFullRow,
    KpiRow,
    MilestoneFullRow,
    OutcomeRow,
    ReadingRow,
)
from yawmi.goals.tasks_store import TaskCounts


@dataclass
class InMemoryGoalsReader:
    outcome_rows: list[OutcomeRow] = field(default_factory=list)
    cycle_rows: list[CycleFullRow] = field(default_factory=list)
    milestone_rows: list[MilestoneFullRow] = field(default_factory=list)
    card_rows: list[CardFullRow] = field(default_factory=list)
    card_field_rows: list[CardFieldsRow] = field(default_factory=list)
    kpi_rows: list[KpiRow] = field(default_factory=list)
    reading_rows: list[ReadingRow] = field(default_factory=list)
    synced: datetime | None = None

    async def outcomes(self) -> list[OutcomeRow]:
        return sorted(self.outcome_rows, key=lambda o: o.code)

    async def cycles(self) -> list[CycleFullRow]:
        return sorted(self.cycle_rows, key=lambda c: c.cycle_no)

    async def milestones(self) -> list[MilestoneFullRow]:
        return list(self.milestone_rows)

    async def cards(self) -> list[CardFullRow]:
        return sorted(self.card_rows, key=lambda c: (c.title, c.page_id))

    async def card_fields(self) -> list[CardFieldsRow]:
        return list(self.card_field_rows)

    async def kpis(self) -> list[KpiRow]:
        return sorted(self.kpi_rows, key=lambda k: k.code)

    async def latest_readings(self) -> dict[str, ReadingRow]:
        newest: dict[str, ReadingRow] = {}
        for row in self.reading_rows:  # a later row of the same day wins, as `created_at` does
            kept = newest.get(row.kpi_code)
            if kept is None or row.day >= kept.day:
                newest[row.kpi_code] = row
        return newest

    async def readings(self, kpi_code: str) -> list[ReadingRow]:
        return sorted((r for r in self.reading_rows if r.kpi_code == kpi_code), key=lambda r: r.day)

    async def last_synced(self) -> datetime | None:
        if self.synced is not None:
            return self.synced
        # as the real mirror: rows carry their sync time, so a non-empty mirror has one
        if self.milestone_rows or self.card_rows:
            return datetime(2026, 11, 10, 6, 0, tzinfo=UTC)
        return None


@dataclass
class _Task:
    id: UUID
    goal_ref: str
    title: str
    due_day: date | None
    done_at: datetime | None
    done_logged_at: datetime | None
    position: int
    archived_at: datetime | None
    seq: int


def _out(t: _Task) -> GoalTaskOut:
    return GoalTaskOut(
        id=t.id,
        goal_ref=t.goal_ref,
        title=t.title,
        due_day=t.due_day,
        done_at=t.done_at,
        position=t.position,
        archived=t.archived_at is not None,
    )


class InMemoryGoalTaskStore:
    def __init__(self) -> None:
        self.tasks: dict[UUID, _Task] = {}

    async def list(self, goal_ref: str) -> list[GoalTaskOut]:
        mine = [t for t in self.tasks.values() if t.goal_ref == goal_ref and t.archived_at is None]
        return [_out(t) for t in sorted(mine, key=lambda t: (t.position, t.seq))]

    async def counts(self) -> dict[str, TaskCounts]:
        counts: dict[str, TaskCounts] = {}
        for t in self.tasks.values():
            if t.archived_at is not None:
                continue
            seen = counts.get(t.goal_ref, TaskCounts(0, 0))
            counts[t.goal_ref] = TaskCounts(seen.done + (t.done_at is not None), seen.total + 1)
        return counts

    async def create(
        self, goal_ref: str, title: str, due_day: date | None, now: datetime
    ) -> GoalTaskOut:
        positions = [t.position for t in self.tasks.values() if t.goal_ref == goal_ref]
        task = _Task(
            id=uuid4(),
            goal_ref=goal_ref,
            title=title,
            due_day=due_day,
            done_at=None,
            done_logged_at=None,
            position=max(positions, default=-1) + 1,
            archived_at=None,
            seq=len(self.tasks),
        )
        self.tasks[task.id] = task
        return _out(task)

    async def patch(
        self, task_id: UUID, changes: Mapping[str, Any], now: datetime
    ) -> GoalTaskOut | None:
        task = self.tasks.get(task_id)
        if task is None:
            return None
        if "title" in changes:
            task.title = changes["title"]
        if "due_day" in changes:
            task.due_day = changes["due_day"]
        if "position" in changes:
            task.position = changes["position"]
        if "done" in changes:
            task.done_at = (task.done_at or now) if changes["done"] else None
            task.done_logged_at = now
        if "archived" in changes:
            task.archived_at = (task.archived_at or now) if changes["archived"] else None
        return _out(task)

    async def mark_from_event(self, task_id: UUID, done: bool, logged_at: datetime) -> None:
        """A `goal_task_set` event: it wins only if not older than the last mark (as the SQL)."""
        task = self.tasks.get(task_id)
        if task is not None and (task.done_logged_at is None or logged_at >= task.done_logged_at):
            self.tasks[task_id] = replace(
                task, done_at=logged_at if done else None, done_logged_at=logged_at
            )
