"""The `EventStore` contract and its Postgres implementation.

`ingest` is one transaction: it stores the new events (`ON CONFLICT (id) DO NOTHING`), then
executes the projection intents of the events that were actually new. A replayed batch finds
every id already stored, so it inserts and projects nothing and still succeeds.

Two properties of `GET /v1/events?since=` follow from how `received_at` is assigned:

* **Commit order.** The transaction takes an advisory lock *before* it reads the clock and
  holds it until commit, so a later batch always carries a later `received_at` than every
  batch committed before it. Without the lock a slow transaction could commit rows older than
  a cursor a client has already moved past, and that client would never see them.
* **Unique, increasing timestamps.** `now()` is the same for every row of a transaction, which
  would make a page boundary inside a batch lose the rest of it (`since` is a bare timestamp).
  Each row of a batch gets the batch time plus one microsecond per position instead, and the
  batch time is `max(clock, newest stored received_at + 1 microsecond)`, so a tie or a clock
  that steps back cannot stamp a batch before one a client may already have passed. `pull` also
  never splits a group of rows sharing one `received_at` (a page may then exceed `limit`).
"""

import json
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Protocol
from uuid import UUID

import asyncpg

from yawmi.events.models import BatchResult, PayloadNotJson, StoredEvent, dump_payload
from yawmi.events.project import (
    BreathSession,
    FocusSession,
    HabitLog,
    Planned,
    habit_codes,
)

# two-key advisory lock, so it cannot collide with the single-key locks other tools may take in
# the shared database (the keys spell "YWMI" and 1)
INGEST_LOCK_KEYS = (0x59574D49, 1)


class UnknownHabits(Exception):
    """Some new events refer to a habit that does not exist; nothing was stored."""

    def __init__(self, indexes: list[int]) -> None:
        super().__init__(f"unknown habit at event positions {indexes}")
        self.indexes = indexes


class InvalidPayloads(Exception):
    """Some payloads cannot be stored as JSON (validation was bypassed); nothing was stored."""

    def __init__(self, indexes: list[int]) -> None:
        super().__init__(f"unstorable payload at event positions {indexes}")
        self.indexes = indexes


def dump_payloads(planned: Sequence[Planned]) -> list[str]:
    """The `jsonb` text of every payload, or `InvalidPayloads` naming the ones that have none."""
    texts: list[str] = []
    bad: list[int] = []
    for item in planned:
        try:
            texts.append(dump_payload(item.event.payload))
        except PayloadNotJson:
            bad.append(item.index)
    if bad:
        raise InvalidPayloads(bad)
    return texts


class EventStore(Protocol):
    async def ingest(self, device_id: UUID, planned: Sequence[Planned]) -> BatchResult:
        """Store the batch atomically; `UnknownHabits` / `InvalidPayloads` store nothing."""
        ...

    async def pull(self, since: datetime | None, limit: int) -> list[StoredEvent]:
        """Events with `received_at > since`, oldest first, never splitting a timestamp."""
        ...


def next_received_base(now: datetime, last: datetime | None) -> datetime:
    """The first `received_at` of a new batch: the clock, but never at or before `last`.

    `last` is the newest `received_at` already stored. Clocks tie and can step backwards (NTP,
    a restart on another host), and the cursor of `GET /v1/events` only moves forward, so a
    batch stamped before `last` could be skipped by a client that already passed it.
    """
    if last is not None and now <= last:
        return last + timedelta(microseconds=1)
    return now


def _utc_now() -> datetime:
    return datetime.now(UTC)


def received_times(base: datetime, count: int) -> list[datetime]:
    """`count` strictly increasing times starting at `base` (one microsecond apart)."""
    return [base + timedelta(microseconds=i) for i in range(count)]


_LOCK = "SELECT pg_advisory_xact_lock($1, $2)"

_INSERT_EVENTS = """
INSERT INTO yawmi.events (id, device_id, type, payload, occurred_at, tz, received_at)
SELECT t.id, $2::uuid, t.type, t.payload::jsonb, t.occurred_at, t.tz, t.received_at
FROM unnest(
  $1::uuid[], $3::text[], $4::text[], $5::timestamptz[], $6::text[], $7::timestamptz[]
) AS t (id, type, payload, occurred_at, tz, received_at)
ON CONFLICT (id) DO NOTHING
RETURNING id
"""

# served by the (received_at, id) index: one step from its end
_NEWEST_RECEIVED = "SELECT max(received_at) FROM yawmi.events"

_KNOWN_HABITS = "SELECT code FROM yawmi.habits WHERE code = ANY($1::text[])"

# last writer wins by event time: an older event arriving late changes nothing
_UPSERT_HABIT_LOG = """
INSERT INTO yawmi.habit_logs (id, habit_code, day, value, status, source, event_id, logged_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (habit_code, day, source) DO UPDATE
SET value = excluded.value,
    status = excluded.status,
    event_id = excluded.event_id,
    logged_at = excluded.logged_at
WHERE excluded.logged_at >= yawmi.habit_logs.logged_at
"""

_INSERT_FOCUS = """
INSERT INTO yawmi.focus_sessions (
  id, device_id, habit_code, goal_ref, day, started_at, ended_at,
  planned_minutes, actual_minutes, focus_rating, next_step, event_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $1)
ON CONFLICT (id) DO NOTHING
"""

_INSERT_BREATH = """
INSERT INTO yawmi.breath_sessions (
  id, device_id, day, started_at, ended_at, pattern,
  breaths_per_min, duration_seconds, completed, event_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $1)
ON CONFLICT (id) DO NOTHING
"""

_PULL = """
SELECT id, device_id, type, payload, occurred_at, tz, received_at
FROM yawmi.events
WHERE received_at > coalesce($1::timestamptz, '-infinity'::timestamptz)
ORDER BY received_at, id
LIMIT $2
"""

# the rest of the last row's timestamp group, so a page never ends inside one
_PULL_REST_OF_GROUP = """
SELECT id, device_id, type, payload, occurred_at, tz, received_at
FROM yawmi.events
WHERE received_at = $1 AND id > $2
ORDER BY id
"""


def habit_log_args(intent: HabitLog) -> tuple[object, ...]:
    # the row id is the event id; an upsert that updates keeps the id of the row it replaces
    return (
        intent.event_id,
        intent.habit_code,
        intent.day,
        intent.value,
        intent.status,
        intent.source,
        intent.event_id,
        intent.logged_at,
    )


def focus_args(intent: FocusSession, device_id: UUID) -> tuple[object, ...]:
    return (
        intent.event_id,
        device_id,
        intent.habit_code,
        intent.goal_ref,
        intent.day,
        intent.started_at,
        intent.ended_at,
        intent.planned_minutes,
        intent.actual_minutes,
        intent.focus_rating,
        intent.next_step,
    )


def breath_args(intent: BreathSession, device_id: UUID) -> tuple[object, ...]:
    return (
        intent.event_id,
        device_id,
        intent.day,
        intent.started_at,
        intent.ended_at,
        intent.pattern,
        intent.breaths_per_min,
        intent.duration_seconds,
        intent.completed,
    )


def stored_event_from_row(row: "asyncpg.Record | dict[str, object]") -> StoredEvent:
    payload = row["payload"]
    return StoredEvent(
        id=row["id"],  # type: ignore[arg-type]
        device_id=row["device_id"],  # type: ignore[arg-type]
        type=row["type"],  # type: ignore[arg-type]
        payload=json.loads(payload) if isinstance(payload, str) else payload,  # type: ignore[arg-type]
        occurred_at=row["occurred_at"],  # type: ignore[arg-type]
        tz=row["tz"],  # type: ignore[arg-type]
        received_at=row["received_at"],  # type: ignore[arg-type]
    )


class AsyncpgEventStore:
    def __init__(self, pool: asyncpg.Pool, clock: Callable[[], datetime] = _utc_now) -> None:
        self._pool = pool
        self._clock = clock

    async def ingest(self, device_id: UUID, planned: Sequence[Planned]) -> BatchResult:
        if not planned:
            return BatchResult(accepted=0, duplicates=0)
        payloads = dump_payloads(planned)  # before any connection or lock is taken
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(_LOCK, *INGEST_LOCK_KEYS)
            # the clock is read only now, with the lock held (see the module docstring), and
            # never earlier than the newest time already stored
            last = await conn.fetchval(_NEWEST_RECEIVED)
            received = received_times(next_received_base(self._clock(), last), len(planned))
            inserted = {
                row["id"]
                for row in await conn.fetch(
                    _INSERT_EVENTS,
                    [item.event.id for item in planned],
                    device_id,
                    [item.event.type for item in planned],
                    payloads,
                    [item.event.occurred_at for item in planned],
                    [item.event.tz for item in planned],
                    received,
                )
            }
            taken: set[UUID] = set()
            new: list[Planned] = []
            for item in planned:  # the first occurrence of an id is the one that was inserted
                if item.event.id in inserted and item.event.id not in taken:
                    taken.add(item.event.id)
                    new.append(item)

            wanted = habit_codes(new)
            if wanted:
                known = {row["code"] for row in await conn.fetch(_KNOWN_HABITS, sorted(wanted))}
                missing = wanted - known
                if missing:
                    # raised inside the transaction: the events inserted above roll back too
                    raise UnknownHabits(
                        [
                            item.index
                            for item in new
                            if isinstance(item.intent, HabitLog | FocusSession)
                            and item.intent.habit_code in missing
                        ]
                    )

            await conn.executemany(
                _UPSERT_HABIT_LOG,
                [habit_log_args(i.intent) for i in new if isinstance(i.intent, HabitLog)],
            )
            await conn.executemany(
                _INSERT_FOCUS,
                [
                    focus_args(i.intent, device_id)
                    for i in new
                    if isinstance(i.intent, FocusSession)
                ],
            )
            await conn.executemany(
                _INSERT_BREATH,
                [
                    breath_args(i.intent, device_id)
                    for i in new
                    if isinstance(i.intent, BreathSession)
                ],
            )
        return BatchResult(accepted=len(inserted), duplicates=len(planned) - len(inserted))

    async def pull(self, since: datetime | None, limit: int) -> list[StoredEvent]:
        rows = list(await self._pool.fetch(_PULL, since, limit))
        if len(rows) == limit:
            last = rows[-1]
            rows += await self._pool.fetch(_PULL_REST_OF_GROUP, last["received_at"], last["id"])
        return [stored_event_from_row(row) for row in rows]
