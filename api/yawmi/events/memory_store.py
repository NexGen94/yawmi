"""In-memory `EventStore`: for tests and local experiments, never for production.

It follows the Postgres store's semantics (idempotent ids, atomic batches, last-writer-wins on
`(habit_code, day, source)`, habit existence checked only for new events, `received_at` strictly
increasing, pages that never split a timestamp) so the HTTP tests can run without a database;
the same API tests also run against Postgres when `TEST_DATABASE_URL` is set.
"""

from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from yawmi.events.models import BatchResult, StoredEvent
from yawmi.events.project import (
    BreathSession,
    FocusSession,
    HabitLog,
    Planned,
    habit_codes,
)
from yawmi.events.store import UnknownHabits, received_times


def _utc_now() -> datetime:
    return datetime.now(UTC)


class InMemoryEventStore:
    def __init__(self, clock: Callable[[], datetime] = _utc_now) -> None:
        self.clock = clock
        self.habits: set[str] = set()  # the habit codes that "exist"
        self.events: dict[UUID, StoredEvent] = {}
        self.habit_logs: dict[tuple[str, date, str], HabitLog] = {}
        self.focus_sessions: list[FocusSession] = []
        self.breath_sessions: list[BreathSession] = []
        self._last_received: datetime | None = None

    async def ingest(self, device_id: UUID, planned: Sequence[Planned]) -> BatchResult:
        base = self.clock()
        if self._last_received is not None and base <= self._last_received:
            base = self._last_received + timedelta(microseconds=1)
        received = received_times(base, len(planned))

        new: list[tuple[Planned, datetime]] = []
        seen: set[UUID] = set()
        for item, at in zip(planned, received, strict=True):
            if item.event.id in self.events or item.event.id in seen:
                continue
            seen.add(item.event.id)
            new.append((item, at))

        missing = habit_codes(item for item, _ in new) - self.habits
        if missing:
            raise UnknownHabits(
                [
                    item.index
                    for item, _ in new
                    if isinstance(item.intent, HabitLog | FocusSession)
                    and item.intent.habit_code in missing
                ]
            )

        for item, at in new:
            event = item.event
            self.events[event.id] = StoredEvent(
                id=event.id,
                device_id=device_id,
                type=event.type,
                payload=event.payload,
                occurred_at=event.occurred_at,
                tz=event.tz,
                received_at=at,
            )
            self._last_received = at
            intent = item.intent
            if isinstance(intent, HabitLog):
                key = (intent.habit_code, intent.day, intent.source)
                current = self.habit_logs.get(key)
                if current is None or intent.logged_at >= current.logged_at:
                    self.habit_logs[key] = intent
            elif isinstance(intent, FocusSession):
                self.focus_sessions.append(intent)
            elif isinstance(intent, BreathSession):
                self.breath_sessions.append(intent)
        return BatchResult(accepted=len(new), duplicates=len(planned) - len(new))

    async def pull(self, since: datetime | None, limit: int) -> list[StoredEvent]:
        rows = sorted(self.events.values(), key=lambda e: (e.received_at, str(e.id)))
        if since is not None:
            rows = [row for row in rows if row.received_at > since]
        page = rows[:limit]
        if len(page) == limit:
            tail = page[-1].received_at
            page += [row for row in rows[limit:] if row.received_at == tail]
        return page
