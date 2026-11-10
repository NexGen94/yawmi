"""Push persistence: the `PushStore` contract and its Postgres implementation.

Tables (`api/db/migrations/0001_yawmi_schema.sql`): `push_subscriptions` (one row per browser
endpoint), `habit_reminders` and `reminder_sends`, plus reads of `habits` and `habit_logs`.
Grants (`0002_yawmi_role.sql`): SELECT/INSERT/UPDATE everywhere in `yawmi`, DELETE on
`push_subscriptions`; nothing here needs more.

`claim_send` is the only thing that authorises a reminder: it inserts `(reminder_id, day)` with
`ON CONFLICT DO NOTHING` and reports whether the row was new. The primary key makes that hold
across ticks, restarts and concurrent processes.
"""

from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Protocol
from uuid import UUID

import asyncpg

from yawmi.today.reader import ACTIVE_HABITS, HABIT_LOGS, HabitRow, LogRow


@dataclass(frozen=True)
class Subscription:
    endpoint: str
    p256dh: str
    auth: str
    device_id: UUID | None = None
    retry_after: datetime | None = None
    last_ok_at: datetime | None = None


@dataclass(frozen=True)
class Reminder:
    id: UUID
    habit_code: str
    at_time: time
    weekday_mask: int


class PushStore(Protocol):
    async def upsert_subscription(
        self, device_id: UUID, endpoint: str, p256dh: str, auth: str
    ) -> None:
        """Insert, or replace keys and owner of an existing endpoint and clear its back-off.

        The endpoint is an unguessable capability URL held by the browser, so whoever presents
        it with its keys owns it: a re-paired browser (new device id) takes its endpoint over.
        """
        ...

    async def delete_subscription(self, device_id: UUID, endpoint: str) -> None:
        """Remove `endpoint` if it belongs to `device_id`; otherwise do nothing."""
        ...

    async def subscriptions(self) -> list[Subscription]:
        """Every subscription (one user), by endpoint."""
        ...

    async def mark_ok(self, endpoint: str, at: datetime) -> None:
        """A send was accepted: record it and clear any back-off."""
        ...

    async def set_retry_after(self, endpoint: str, until: datetime) -> None: ...

    async def drop(self, endpoint: str) -> None:
        """The push service says the subscription is gone (404/410): forget it."""
        ...

    async def active_reminders(self) -> list[Reminder]: ...

    async def active_habits(self, day: date) -> list[HabitRow]:
        """Active habits whose window contains `day` (as `TodayReader.active_habits`)."""
        ...

    async def habit_logs(self, first: date, last: date) -> list[LogRow]: ...

    async def claim_send(self, reminder_id: UUID, day: date) -> bool:
        """Record the reminder as sent for `day`; `True` only for the first caller."""
        ...


_UPSERT = """
INSERT INTO yawmi.push_subscriptions (endpoint, device_id, p256dh, auth)
VALUES ($1, $2, $3, $4)
ON CONFLICT (endpoint) DO UPDATE
SET device_id = excluded.device_id,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    retry_after = NULL
"""

_DELETE_OWN = "DELETE FROM yawmi.push_subscriptions WHERE endpoint = $1 AND device_id = $2"

_SUBSCRIPTIONS = """
SELECT endpoint, p256dh, auth, device_id, retry_after, last_ok_at
FROM yawmi.push_subscriptions
ORDER BY endpoint
"""

_MARK_OK = (
    "UPDATE yawmi.push_subscriptions SET last_ok_at = $2, retry_after = NULL WHERE endpoint = $1"
)
_RETRY_AFTER = "UPDATE yawmi.push_subscriptions SET retry_after = $2 WHERE endpoint = $1"
_DROP = "DELETE FROM yawmi.push_subscriptions WHERE endpoint = $1"

_REMINDERS = """
SELECT id, habit_code, at_time, weekday_mask
FROM yawmi.habit_reminders
WHERE active
ORDER BY at_time, id
"""

_CLAIM = """
INSERT INTO yawmi.reminder_sends (reminder_id, day) VALUES ($1, $2)
ON CONFLICT DO NOTHING
RETURNING reminder_id
"""

ALL_SQL = (
    _UPSERT,
    _DELETE_OWN,
    _SUBSCRIPTIONS,
    _MARK_OK,
    _RETRY_AFTER,
    _DROP,
    _REMINDERS,
    _CLAIM,
)


class AsyncpgPushStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def upsert_subscription(
        self, device_id: UUID, endpoint: str, p256dh: str, auth: str
    ) -> None:
        await self._pool.execute(_UPSERT, endpoint, device_id, p256dh, auth)

    async def delete_subscription(self, device_id: UUID, endpoint: str) -> None:
        await self._pool.execute(_DELETE_OWN, endpoint, device_id)

    async def subscriptions(self) -> list[Subscription]:
        return [Subscription(**dict(r)) for r in await self._pool.fetch(_SUBSCRIPTIONS)]

    async def mark_ok(self, endpoint: str, at: datetime) -> None:
        await self._pool.execute(_MARK_OK, endpoint, at)

    async def set_retry_after(self, endpoint: str, until: datetime) -> None:
        await self._pool.execute(_RETRY_AFTER, endpoint, until)

    async def drop(self, endpoint: str) -> None:
        await self._pool.execute(_DROP, endpoint)

    async def active_reminders(self) -> list[Reminder]:
        return [Reminder(**dict(r)) for r in await self._pool.fetch(_REMINDERS)]

    async def active_habits(self, day: date) -> list[HabitRow]:
        return [HabitRow(**dict(r)) for r in await self._pool.fetch(ACTIVE_HABITS, day)]

    async def habit_logs(self, first: date, last: date) -> list[LogRow]:
        return [LogRow(**dict(r)) for r in await self._pool.fetch(HABIT_LOGS, first, last)]

    async def claim_send(self, reminder_id: UUID, day: date) -> bool:
        return await self._pool.fetchval(_CLAIM, reminder_id, day) is not None
