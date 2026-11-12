"""Goal edits: the contract and Postgres (`yawmi.goal_edits`, design §11).

An edit is a row over the Notion mirror, never a write into it (`yawmi_api` only reads `raqib`).
At most one edit per page and field is `pending` (a partial unique index): a new edit supersedes
the pending one under a transaction-scoped advisory lock on `(page_id, field)`, so two concurrent
edits of the same field serialise instead of failing on the index. Nothing is ever deleted (the
role has no `DELETE` on the table): a cancelled edit becomes `cancelled`.

Only a pending edit takes a result: `finish` (to `applied`, `conflict` or `failed`) is a
conditional update that returns `None` for an edit that is not pending, so a late result never
overwrites a newer state. `cancel` closes a pending or conflicting edit as `cancelled` and appends
a dated line to its note; `applied`, `failed`, `superseded` and `cancelled` are final.
"""

import json
from datetime import datetime
from typing import Protocol
from uuid import UUID, uuid4

import asyncpg

from yawmi.notion.changes import EditStatus, GoalEdit, GoalEditOut

_COLUMNS = (
    "id, target_kind, page_id, field, old_value, new_value, note, status, created_at,"
    " applied_at, error"
)


class EditStore(Protocol):
    async def record(
        self,
        page_id: str,
        field: str,
        edit: GoalEdit | None,
        device_id: UUID | None,
        now: datetime,
    ) -> GoalEditOut | None:
        """Supersede the pending edit of `(page_id, field)`, then store `edit` (if any) as
        pending, atomically. The new edit, or `None` when there is none to store."""
        ...

    async def of_page(self, page_id: str) -> list[GoalEditOut]:
        """Every edit of a page, oldest first."""
        ...

    async def current(self) -> list[GoalEditOut]:
        """What the overlay needs: every pending edit, and the latest applied edit of each
        `(page_id, field)`."""
        ...

    async def pending(self, limit: int) -> list[GoalEditOut]:
        """The pending edits in creation order, at most `limit`."""
        ...

    async def get(self, edit_id: UUID) -> GoalEditOut | None: ...

    async def cancel(self, edit_id: UUID, note_line: str) -> GoalEditOut | None:
        """A pending or conflicting edit becomes `cancelled`, `note_line` appended to its note;
        `None` if it is in any other state (or does not exist)."""
        ...

    async def finish(
        self, edit_id: UUID, status: EditStatus, applied_at: datetime | None, error: str | None
    ) -> GoalEditOut | None:
        """A pending edit takes its result; `None` if it is not pending."""
        ...

    # last: inside the class body the name `list` is the method from here on
    async def list(self, status: EditStatus | None) -> list[GoalEditOut]:
        """Every edit (of `status`, if given), newest first."""
        ...


LOCK_FIELD = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"

SUPERSEDE_PENDING = """
UPDATE yawmi.goal_edits
SET status = 'superseded'
WHERE page_id = $1 AND field = $2 AND status = 'pending'
"""

INSERT_EDIT = f"""
INSERT INTO yawmi.goal_edits
  (id, target_kind, page_id, field, old_value, new_value, note, status, device_id, created_at)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'pending', $8, $9)
RETURNING {_COLUMNS}
"""

EDITS_OF_PAGE = f"""
SELECT {_COLUMNS}
FROM yawmi.goal_edits
WHERE page_id = $1
ORDER BY created_at, id
"""

CURRENT_EDITS = f"""
SELECT {_COLUMNS}
FROM yawmi.goal_edits
WHERE status = 'pending'
UNION ALL
SELECT {_COLUMNS}
FROM (
  SELECT DISTINCT ON (page_id, field) {_COLUMNS}
  FROM yawmi.goal_edits
  WHERE status = 'applied' AND applied_at IS NOT NULL
  ORDER BY page_id, field, applied_at DESC, created_at DESC, id DESC
) AS latest
"""

LIST_EDITS = f"""
SELECT {_COLUMNS}
FROM yawmi.goal_edits
WHERE $1::text IS NULL OR status = $1::text
ORDER BY created_at DESC, id DESC
"""

PENDING_EDITS = f"""
SELECT {_COLUMNS}
FROM yawmi.goal_edits
WHERE status = 'pending'
ORDER BY created_at, id
LIMIT $1
"""

GET_EDIT = f"SELECT {_COLUMNS} FROM yawmi.goal_edits WHERE id = $1"

CANCEL_EDIT = f"""
UPDATE yawmi.goal_edits
SET status = 'cancelled', note = note || $2
WHERE id = $1 AND status IN ('pending', 'conflict')
RETURNING {_COLUMNS}
"""

FINISH_EDIT = f"""
UPDATE yawmi.goal_edits
SET status = $2, applied_at = $3, error = $4
WHERE id = $1 AND status = 'pending'
RETURNING {_COLUMNS}
"""

ALL_SQL = (
    LOCK_FIELD,
    SUPERSEDE_PENDING,
    INSERT_EDIT,
    EDITS_OF_PAGE,
    CURRENT_EDITS,
    LIST_EDITS,
    PENDING_EDITS,
    GET_EDIT,
    CANCEL_EDIT,
    FINISH_EDIT,
)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def edit_out(r: asyncpg.Record) -> GoalEditOut:
    return GoalEditOut(
        id=r["id"],
        target_kind=r["target_kind"],
        page_id=r["page_id"],
        field=r["field"],
        old_value=None if r["old_value"] is None else json.loads(r["old_value"]),
        new_value=json.loads(r["new_value"]),
        note=r["note"],
        status=r["status"],
        created_at=r["created_at"],
        applied_at=r["applied_at"],
        error=r["error"],
    )


class AsyncpgEditStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def record(
        self,
        page_id: str,
        field: str,
        edit: GoalEdit | None,
        device_id: UUID | None,
        now: datetime,
    ) -> GoalEditOut | None:
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(LOCK_FIELD, f"{page_id}\x1f{field}")
            await conn.execute(SUPERSEDE_PENDING, page_id, field)
            if edit is None:
                return None
            row = await conn.fetchrow(
                INSERT_EDIT,
                uuid4(),
                edit.target_kind,
                page_id,
                field,
                _json(edit.old_value),
                _json(edit.new_value),
                edit.note,
                device_id,
                now,
            )
        assert row is not None
        return edit_out(row)

    async def of_page(self, page_id: str) -> list[GoalEditOut]:
        return [edit_out(r) for r in await self._pool.fetch(EDITS_OF_PAGE, page_id)]

    async def current(self) -> list[GoalEditOut]:
        return [edit_out(r) for r in await self._pool.fetch(CURRENT_EDITS)]

    async def pending(self, limit: int) -> list[GoalEditOut]:
        return [edit_out(r) for r in await self._pool.fetch(PENDING_EDITS, limit)]

    async def get(self, edit_id: UUID) -> GoalEditOut | None:
        row = await self._pool.fetchrow(GET_EDIT, edit_id)
        return None if row is None else edit_out(row)

    async def cancel(self, edit_id: UUID, note_line: str) -> GoalEditOut | None:
        row = await self._pool.fetchrow(CANCEL_EDIT, edit_id, note_line)
        return None if row is None else edit_out(row)

    async def finish(
        self, edit_id: UUID, status: EditStatus, applied_at: datetime | None, error: str | None
    ) -> GoalEditOut | None:
        row = await self._pool.fetchrow(FINISH_EDIT, edit_id, status, applied_at, error)
        return None if row is None else edit_out(row)

    # last: inside the class body the name `list` is the method from here on
    async def list(self, status: EditStatus | None) -> list[GoalEditOut]:
        return [edit_out(r) for r in await self._pool.fetch(LIST_EDITS, status)]
