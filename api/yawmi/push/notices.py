"""Push notices providers for day reminders and notifications."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from yawmi.domain.periods import WeekStart, weekday_bit
from yawmi.prefs.models import DayReminderItemIO, SettingsOut

WINDOW = timedelta(minutes=10)


@dataclass(frozen=True, slots=True)
class Notice:
    kind: str
    ref: str
    body: str
    navigate: str


@dataclass(frozen=True, slots=True)
class NoticeContext:
    now: datetime
    local: datetime
    day: date
    prefs: Any
    journal: Any
    week_start: WeekStart


def _is_due(item: DayReminderItemIO | None, local: datetime) -> date | None:
    if item is None:
        return None
    zone = local.tzinfo
    hour, minute = map(int, item.time.split(":"))
    t = time(hour, minute)
    for day in (local.date(), local.date() - timedelta(days=1)):
        start = datetime.combine(day, t, zone)
        if start <= local <= start + WINDOW and (item.days_mask >> weekday_bit(day) & 1):
            return day
    return None


async def day_reminder_notices(ctx: NoticeContext) -> list[Notice]:
    if ctx.prefs is None:
        return []
    settings: SettingsOut = await ctx.prefs.get()
    reminders = settings.day_reminders
    notices: list[Notice] = []

    # Evening reminder
    evening_day = _is_due(reminders.evening, ctx.local)
    if evening_day is not None:
        has_evening_entry = False
        if ctx.journal is not None:
            entries = await ctx.journal.entries(evening_day, evening_day)
            has_evening_entry = any(e.part == "evening" for e in entries)
        if not has_evening_entry:
            notices.append(
                Notice(
                    kind="day_reminder",
                    ref="evening",
                    body="يومية المساء",
                    navigate="/day/evening",
                )
            )

    # Morning reminder
    morning_day = _is_due(reminders.morning, ctx.local)
    if morning_day is not None:
        has_morning_entry = False
        if ctx.journal is not None:
            entries = await ctx.journal.entries(morning_day, morning_day)
            has_morning_entry = any(e.part == "morning" for e in entries)
        if not has_morning_entry:
            notices.append(
                Notice(
                    kind="day_reminder",
                    ref="morning",
                    body="يومية الصباح",
                    navigate="/day/morning",
                )
            )

    # Weekly review reminder
    weekly_day = _is_due(reminders.weekly, ctx.local)
    if weekly_day is not None:
        notices.append(
            Notice(
                kind="day_reminder",
                ref="weekly",
                body="مراجعة الأسبوع",
                navigate="/review",
            )
        )

    return notices


NoticeProvider = Callable[[NoticeContext], Awaitable[list[Notice]]]
PROVIDERS: list[NoticeProvider] = [day_reminder_notices]
