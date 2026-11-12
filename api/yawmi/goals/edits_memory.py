"""In-memory `EditStore`: for tests and local experiments, never production.

The same rules as `yawmi.goals.edits_store`: one pending edit per page and field, nothing
deleted, and only a pending edit takes a later state. Creation order breaks ties of `created_at`
by insertion, as the SQL breaks them by id.
"""

from datetime import datetime
from uuid import UUID, uuid4

from yawmi.notion.changes import CANCELLABLE, EditStatus, GoalEdit, GoalEditOut


class InMemoryEditStore:
    def __init__(self) -> None:
        self.rows: list[GoalEditOut] = []  # in insertion order

    def _ordered(self) -> list[GoalEditOut]:
        return sorted(self.rows, key=lambda e: e.created_at)  # stable: insertion breaks ties

    def _set(
        self, edit_id: UUID, states: tuple[str, ...] = ("pending",), **changes: object
    ) -> GoalEditOut | None:
        for i, row in enumerate(self.rows):
            if row.id == edit_id and row.status in states:
                self.rows[i] = row.model_copy(update=changes)
                return self.rows[i]
        return None

    async def record(
        self,
        page_id: str,
        field: str,
        edit: GoalEdit | None,
        device_id: UUID | None,
        now: datetime,
    ) -> GoalEditOut | None:
        for row in list(self.rows):
            if (row.page_id, row.field, row.status) == (page_id, field, "pending"):
                self._set(row.id, status="superseded")
        if edit is None:
            return None
        out = GoalEditOut(
            id=uuid4(),
            target_kind=edit.target_kind,
            page_id=page_id,
            field=field,
            old_value=edit.old_value,
            new_value=edit.new_value,
            note=edit.note,
            status="pending",
            created_at=now,
            applied_at=None,
            error=None,
        )
        self.rows.append(out)
        return out

    async def of_page(self, page_id: str) -> list[GoalEditOut]:
        return [e for e in self._ordered() if e.page_id == page_id]

    async def current(self) -> list[GoalEditOut]:
        pending = [e for e in self.rows if e.status == "pending"]
        latest: dict[tuple[str, str], GoalEditOut] = {}
        for e in self._ordered():
            if e.status != "applied" or e.applied_at is None:
                continue
            kept = latest.get((e.page_id, e.field))
            if kept is None or (e.applied_at, e.created_at) >= (kept.applied_at, kept.created_at):  # type: ignore[operator]
                latest[(e.page_id, e.field)] = e
        return [*pending, *latest.values()]

    async def pending(self, limit: int) -> list[GoalEditOut]:
        return [e for e in self._ordered() if e.status == "pending"][:limit]

    async def get(self, edit_id: UUID) -> GoalEditOut | None:
        return next((e for e in self.rows if e.id == edit_id), None)

    async def cancel(self, edit_id: UUID, note_line: str) -> GoalEditOut | None:
        row = await self.get(edit_id)
        if row is None:
            return None
        return self._set(edit_id, CANCELLABLE, status="cancelled", note=row.note + note_line)

    async def finish(
        self, edit_id: UUID, status: EditStatus, applied_at: datetime | None, error: str | None
    ) -> GoalEditOut | None:
        return self._set(edit_id, status=status, applied_at=applied_at, error=error)

    # last: inside the class body the name `list` is the method from here on
    async def list(self, status: EditStatus | None) -> list[GoalEditOut]:
        mine = [e for e in self._ordered() if status is None or e.status == status]
        return mine[::-1]
