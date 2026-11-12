"""Goal tasks: the contract and Postgres (`yawmi.goal_tasks`).

A task is the user's own line under a goal (an outcome code, a card or a milestone page id). It
is never deleted: `archived_at` closes it, and an archived task leaves every total.

Two writers mark a task done. A direct edit (`PATCH`) writes `done_at` and sets `done_logged_at`
to the edit's instant. A `goal_task_set` event does the same with its own instant, but only if
that instant is not older than `done_logged_at` (see `yawmi.events.store`): so an event queued
offline before a direct edit never overrides it. An edit holds the row's lock (`FOR UPDATE`)
for its whole read-merge-write.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Protocol
from uuid import UUID, uuid4

import asyncpg

from yawmi.goals.models import GoalTaskOut

_COLUMNS = "id, goal_ref, title, due_day, done_at, position, archived_at"


@dataclass(frozen=True)
class TaskCounts:
    done: int
    total: int


class GoalTaskStore(Protocol):
    async def list(self, goal_ref: str) -> list[GoalTaskOut]:
        """The tasks of a goal that are not archived, by position then creation."""
        ...

    async def counts(self) -> dict[str, TaskCounts]:
        """Done and total tasks per goal reference, archived ones left out."""
        ...

    async def create(
        self, goal_ref: str, title: str, due_day: date | None, now: datetime
    ) -> GoalTaskOut:
        """A new open task after the goal's last one."""
        ...

    async def patch(
        self, task_id: UUID, changes: Mapping[str, Any], now: datetime
    ) -> GoalTaskOut | None:
        """Apply `changes` (keys among `title`, `due_day`, `done`, `archived`, `position`).

        `done` writes `done_at` (`now` or cleared) and `done_logged_at = now`; `archived` writes
        `archived_at`. `None` if there is no such task.
        """
        ...


LIST_TASKS = f"""
SELECT {_COLUMNS}
FROM yawmi.goal_tasks
WHERE goal_ref = $1 AND archived_at IS NULL
ORDER BY position, created_at, id
"""

COUNT_TASKS = """
SELECT goal_ref, count(*) FILTER (WHERE done_at IS NOT NULL) AS done, count(*) AS total
FROM yawmi.goal_tasks
WHERE archived_at IS NULL
GROUP BY goal_ref
"""

INSERT_TASK = f"""
INSERT INTO yawmi.goal_tasks (id, goal_ref, title, due_day, position, created_at, updated_at)
VALUES (
  $1, $2, $3, $4,
  (SELECT coalesce(max(position) + 1, 0) FROM yawmi.goal_tasks WHERE goal_ref = $2),
  $5, $5
)
RETURNING {_COLUMNS}
"""

LOCK_TASK = f"SELECT {_COLUMNS} FROM yawmi.goal_tasks WHERE id = $1 FOR UPDATE"

UPDATE_TASK = f"""
UPDATE yawmi.goal_tasks
SET title = $2, due_day = $3, done_at = $4, done_logged_at = $5, position = $6,
    archived_at = $7, updated_at = $8
WHERE id = $1
RETURNING {_COLUMNS}
"""

# the logged-at column is not in the output: it is only ever read here, under the row's lock
LOCK_DONE_LOGGED = "SELECT done_logged_at FROM yawmi.goal_tasks WHERE id = $1"

ALL_SQL = (LIST_TASKS, COUNT_TASKS, INSERT_TASK, LOCK_TASK, UPDATE_TASK, LOCK_DONE_LOGGED)


def task_out(r: asyncpg.Record) -> GoalTaskOut:
    return GoalTaskOut(
        id=r["id"],
        goal_ref=r["goal_ref"],
        title=r["title"],
        due_day=r["due_day"],
        done_at=r["done_at"],
        position=r["position"],
        archived=r["archived_at"] is not None,
    )


class AsyncpgGoalTaskStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list(self, goal_ref: str) -> list[GoalTaskOut]:
        return [task_out(r) for r in await self._pool.fetch(LIST_TASKS, goal_ref)]

    async def counts(self) -> dict[str, TaskCounts]:
        rows = await self._pool.fetch(COUNT_TASKS)
        return {r["goal_ref"]: TaskCounts(r["done"], r["total"]) for r in rows}

    async def create(
        self, goal_ref: str, title: str, due_day: date | None, now: datetime
    ) -> GoalTaskOut:
        row = await self._pool.fetchrow(INSERT_TASK, uuid4(), goal_ref, title, due_day, now)
        assert row is not None
        return task_out(row)

    async def patch(
        self, task_id: UUID, changes: Mapping[str, Any], now: datetime
    ) -> GoalTaskOut | None:
        async with self._pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(LOCK_TASK, task_id)
            if row is None:
                return None
            done_logged = await conn.fetchval(LOCK_DONE_LOGGED, task_id)
            done_at = row["done_at"]
            if "done" in changes:
                done_at, done_logged = ((row["done_at"] or now) if changes["done"] else None), now
            archived_at = row["archived_at"]
            if "archived" in changes:
                archived_at = (archived_at or now) if changes["archived"] else None
            saved = await conn.fetchrow(
                UPDATE_TASK,
                task_id,
                changes.get("title", row["title"]),
                changes["due_day"] if "due_day" in changes else row["due_day"],
                done_at,
                done_logged,
                changes.get("position", row["position"]),
                archived_at,
                now,
            )
        assert saved is not None
        return task_out(saved)
