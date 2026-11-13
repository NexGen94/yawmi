"""Push notice providers: what to say besides the habit reminders, and when (design §9.3).

A provider is `async (ctx, now) -> list[Notice]`. Each `tick` calls every provider in
`PROVIDERS`; a notice is sent once per `(kind, ref, day)`, `day` being the day it belongs to (a
reminder at 23:55 still due at 00:02 belongs to the day before), claimed in `notice_sends`.
This module holds the day reminders (morning, evening, weekly review), the goal indicator
reminders, the daily late summary and the focus plan reminders.

The last two need the goals: `NoticeContext.goal_sources` (a `GoalSources`) carries the mirror,
the habits and logs, the tasks and the stored indicators; without it they say nothing.
"""

import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from yawmi.domain.periods import WeekStart, weekday_bit
from yawmi.goals.models import GoalIndicatorValue
from yawmi.goals.service import GoalSources, load_goals, shown_milestones
from yawmi.goals.tasks_store import TaskCounts
from yawmi.habits.models import ReminderIO, domain_logs
from yawmi.habits.state import habit_state
from yawmi.indicators.compute import indicator_value
from yawmi.indicators.models import IndicatorIO
from yawmi.prefs.models import SettingsOut
from yawmi.today.assemble import habit_spec
from yawmi.today.reader import LogRow

log = logging.getLogger("yawmi.push")

# how far back the logs of a habit are read to judge it late: the longest `every_n_days` gap
LOG_LOOKBACK = timedelta(days=370)
EVERY_DAY = 127

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
    goal_sources: GoalSources | None = None
    focus: Any = None  # FocusStore


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


def count_items_ar(n: int) -> str:
    """«بند واحد» · «بندان» · «3 بنود» حتى 10 · «11 بنداً» فأكثر."""
    if n == 1:
        return "بند واحد"
    if n == 2:
        return "بندان"
    return f"{n} بنود" if n <= 10 else f"{n} بنداً"


def _plain(number: float) -> str:
    """A number as the notice shows it: no trailing `.0`, one decimal at most."""
    return f"{round(number, 1):g}"


def _goal_notice(
    item: IndicatorIO,
    day: date,
    known: dict[str, tuple[str, GoalIndicatorValue]],
    counts: Mapping[str, TaskCounts],
) -> Notice | None:
    """The reminder of one goal indicator, or `None` when its goal is complete or unmeasured."""
    if item.subject_ref in known:
        title, value = known[item.subject_ref]
    else:  # not in the mirror (empty before the sync): measured by its tasks
        tasks = counts.get(item.subject_ref)
        title = item.subject_ref
        value = indicator_value(
            item.source,
            milestones_done=0,
            milestones_total=0,
            habit_completions=[],
            tasks_done=tasks.done if tasks else 0,
            tasks_total=tasks.total if tasks else 0,
            target=item.target,
        )
    if value.completion is None or value.completion >= 1 or value.value is None:
        return None
    body = f"{item.title_ar or title}: {_plain(value.value)} من {_plain(value.target or 0)}"
    return Notice("goal_indicator", item.subject_ref, day, body, f"/goals/{item.subject_ref}")


async def goal_indicator_notices(ctx: NoticeContext, now: datetime) -> list[Notice]:
    """The reminder of each goal indicator that has one, while its goal is not finished.

    The body is «{العنوان}: {القيمة} من {الهدف}», quoting the indicator the screen shows
    (`load_goals`). A goal that is complete, or has nothing to measure yet, is not reminded.
    A goal that is not in the mirror (it is empty before the sync) is measured by its tasks.
    """
    sources = ctx.goal_sources
    if sources is None:
        return []
    due: list[tuple[IndicatorIO, date]] = []
    for item in await sources.indicators.list():
        day = _due_day(item.reminder, ctx.local) if item.subject_kind == "goal" else None
        if day is not None:
            due.append((item, day))
    if not due:
        return []
    counts = await sources.tasks.counts()
    notices: list[Notice] = []
    # each notice is valued for the day it is claimed for: after midnight that is yesterday
    for day in sorted({d for _, d in due}):
        goals = await load_goals(sources, day, ctx.week_start)
        known = {o.code: (o.title, o.indicator) for o in goals.outcomes}
        known.update({c.page_id: (c.title, c.indicator) for c in goals.cards})
        for item, due_day in due:
            if due_day == day:
                notice = _goal_notice(item, day, known, counts)
                if notice is not None:
                    notices.append(notice)
    return notices


async def _late_titles(sources: GoalSources, day: date, week_start: WeekStart) -> list[str]:
    """Titles of what is late on `day`: open milestones past their due day (oldest first), then
    the habits whose state is `late` (by code). The milestones are the shown ones: one closed or
    moved by a goal edit is not late."""
    overdue = sorted(
        (
            m
            for m in await shown_milestones(sources.goals, sources.edits)
            if not m.done and m.due_date and m.due_date < day
        ),
        key=lambda m: (m.due_date, m.title, m.page_id),
    )
    titles = [m.title for m in overdue]
    habits = await sources.today.active_habits(day)
    if habits:
        by_habit: dict[str, list[LogRow]] = {}
        for row in await sources.today.habit_logs(day - LOG_LOOKBACK, day):
            by_habit.setdefault(row.habit_code, []).append(row)
        for habit in habits:  # already by code
            try:
                state = habit_state(
                    habit_spec(habit), domain_logs(by_habit.get(habit.code, [])), day, week_start
                )
            except Exception as exc:  # noqa: BLE001  # one bad habit row must not stop the others
                log.warning("habit %s skipped: %s", habit.code, type(exc).__name__)
                continue
            if state == "late":
                titles.append(habit.title_ar)
    return titles


async def late_summary_notices(ctx: NoticeContext, now: datetime) -> list[Notice]:
    """One notice a day at `late_notice_time`, when something is late (design §9.2).

    It counts the open milestones past their day and the habits `habit_state` calls `late`,
    and is switched off by `late_notice_enabled`.
    """
    sources = ctx.goal_sources
    if sources is None or ctx.prefs is None:
        return []
    settings: SettingsOut = await ctx.prefs.get()
    if not settings.late_notice_enabled:
        return []
    hour, minute = map(int, settings.late_notice_time.split(":"))
    days = due_days(time(hour, minute), EVERY_DAY, ctx.local)
    if not days:
        return []
    titles = await _late_titles(sources, days[0], ctx.week_start)
    if not titles:
        return []
    body = f"متأخر اليوم: {count_items_ar(len(titles))}. أولها: {titles[0]}."
    return [Notice("late_summary", "daily", days[0], body, "/")]


# a focus session that began this close to a plan's start time is the plan being kept
FOCUS_STARTED_NEAR = timedelta(minutes=30)


async def _focus_began_near(focus: Any, day: date, at: time, local: datetime) -> bool:
    start = datetime.combine(day, at, local.tzinfo)
    sessions = await focus.sessions(day, day + _ONE_DAY)
    return any(abs(s.started_at - start) <= FOCUS_STARTED_NEAR for s in sessions)


async def focus_plan_notices(ctx: NoticeContext, now: datetime) -> list[Notice]:
    """One notice for each active scheduled focus plan whose start time has just come.

    The body is «كتلة تركيز: {العنوان}» and it opens `/focus?plan=<id>`. Nothing is said when a
    focus session already began within half an hour of the start (before or after it): the block
    is being kept.
    """
    if ctx.focus is None:
        return []
    found: list[Notice] = []
    for plan in await ctx.focus.plans():
        if plan.weekday_mask is None or plan.start_time is None:
            continue
        hour, minute = map(int, plan.start_time.split(":"))
        at = time(hour, minute)
        for day in due_days(at, plan.weekday_mask, ctx.local):
            if await _focus_began_near(ctx.focus, day, at, ctx.local):
                continue
            body = f"كتلة تركيز: {plan.title_ar}"
            found.append(Notice("focus_plan", str(plan.id), day, body, f"/focus?plan={plan.id}"))
    return found


PROVIDERS: list[NoticeProvider] = [
    day_reminder_notices,
    goal_indicator_notices,
    late_summary_notices,
    focus_plan_notices,
]
