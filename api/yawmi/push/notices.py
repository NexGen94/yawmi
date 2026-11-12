"""Push notice providers: what to say besides the habit reminders, and when (design §9.3).

A provider is `async (ctx, now) -> list[Notice]`. Each `tick` calls every provider in
`PROVIDERS`; a notice is sent once per `(kind, ref, day)`, `day` being the day it belongs to (a
reminder at 23:55 still due at 00:02 belongs to the day before), claimed in `notice_sends`.
This module holds the day reminders (morning, evening, weekly review); the late summary and the
goal indicators add theirs to the list.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from yawmi.domain.periods import WeekStart, weekday_bit
from yawmi.habits.models import ReminderIO
from yawmi.prefs.models import SettingsOut

WINDOW = timedelta(minutes=10)
_ONE_DAY = timedelta(days=1)


@dataclass(frozen=True, slots=True)
class Notice:
    kind: str
    ref: str
    day: date
    body: str
    navigate: str


@dataclass(frozen=True, slots=True)
class NoticeContext:
    local: datetime  # the tick's instant in the plan's zone
    prefs: Any  # PrefsStore
    journal: Any  # JournalReader
    week_start: WeekStart


NoticeProvider = Callable[[NoticeContext, datetime], Awaitable[list[Notice]]]


def due_days(at: time, weekday_mask: int, local: datetime) -> list[date]:
    """The local days whose occurrence at `at` has its 10-minute window around `local`.

    Near midnight that may be yesterday: a 23:55 reminder is still due at 00:03.
    """
    days = []
    for day in (local.date(), local.date() - _ONE_DAY):
        start = datetime.combine(day, at, local.tzinfo)
        if start <= local <= start + WINDOW and weekday_mask >> weekday_bit(day) & 1:
            days.append(day)
    return days


def _due_day(item: ReminderIO | None, local: datetime) -> date | None:
    """The day a day-reminder `item` is due for at `local`, if any."""
    if item is None:
        return None
    hour, minute = map(int, item.time.split(":"))
    days = due_days(time(hour, minute), item.days_mask, local)
    return days[0] if days else None


async def _journal_part_saved(ctx: NoticeContext, day: date, part: str) -> bool:
    if ctx.journal is None:
        return False
    entries = await ctx.journal.entries(day, day)
    return any(e.part == part for e in entries)


async def day_reminder_notices(ctx: NoticeContext, now: datetime) -> list[Notice]:
    if ctx.prefs is None:
        return []
    settings: SettingsOut = await ctx.prefs.get()
    reminders = settings.day_reminders
    notices: list[Notice] = []
    for part, item, body in (
        ("evening", reminders.evening, "يومية المساء"),
        ("morning", reminders.morning, "يومية الصباح"),
    ):
        day = _due_day(item, ctx.local)
        if day is not None and not await _journal_part_saved(ctx, day, part):
            notices.append(Notice("day_reminder", part, day, body, f"/day/{part}"))
    weekly_day = _due_day(reminders.weekly, ctx.local)
    if weekly_day is not None:
        notices.append(Notice("day_reminder", "weekly", weekly_day, "مراجعة الأسبوع", "/review"))
    return notices


PROVIDERS: list[NoticeProvider] = [day_reminder_notices]
