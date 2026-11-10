"""In-memory `PushStore`: for tests and local experiments, never for production.

It applies the same rules as the SQL in `yawmi.push.store`, so the same tests run against both.
"""

from dataclasses import dataclass, field, replace
from datetime import date, datetime
from uuid import UUID

from yawmi.push.store import Reminder, Subscription
from yawmi.today.reader import HabitRow, LogRow


@dataclass
class InMemoryPushStore:
    subs: dict[str, Subscription] = field(default_factory=dict)
    reminders: list[Reminder] = field(default_factory=list)
    inactive_reminders: set[UUID] = field(default_factory=set)
    habits: list[HabitRow] = field(default_factory=list)
    inactive: set[str] = field(default_factory=set)  # habit codes with `active = false`
    logs: list[LogRow] = field(default_factory=list)
    sends: set[tuple[UUID, date]] = field(default_factory=set)

    async def upsert_subscription(
        self, device_id: UUID, endpoint: str, p256dh: str, auth: str
    ) -> None:
        old = self.subs.get(endpoint)
        self.subs[endpoint] = Subscription(
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
            device_id=device_id,
            retry_after=None,
            last_ok_at=old.last_ok_at if old else None,
        )

    async def delete_subscription(self, device_id: UUID, endpoint: str) -> None:
        sub = self.subs.get(endpoint)
        if sub is not None and sub.device_id == device_id:
            del self.subs[endpoint]

    async def subscriptions(self) -> list[Subscription]:
        return [self.subs[e] for e in sorted(self.subs)]

    async def mark_ok(self, endpoint: str, at: datetime) -> None:
        if endpoint in self.subs:
            self.subs[endpoint] = replace(self.subs[endpoint], last_ok_at=at, retry_after=None)

    async def set_retry_after(self, endpoint: str, until: datetime) -> None:
        if endpoint in self.subs:
            self.subs[endpoint] = replace(self.subs[endpoint], retry_after=until)

    async def drop(self, endpoint: str) -> None:
        self.subs.pop(endpoint, None)

    async def active_reminders(self) -> list[Reminder]:
        return sorted(
            (r for r in self.reminders if r.id not in self.inactive_reminders),
            key=lambda r: (r.at_time, r.id),
        )

    async def active_habits(self, day: date) -> list[HabitRow]:
        return sorted(
            (
                h
                for h in self.habits
                if h.code not in self.inactive
                and h.start_day <= day
                and (h.end_day is None or h.end_day >= day)
            ),
            key=lambda h: h.code,
        )

    async def habit_logs(self, first: date, last: date) -> list[LogRow]:
        return [log for log in self.logs if first <= log.day <= last]

    async def claim_send(self, reminder_id: UUID, day: date) -> bool:
        if (reminder_id, day) in self.sends:
            return False
        self.sends.add((reminder_id, day))
        return True
