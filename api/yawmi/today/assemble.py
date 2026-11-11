"""Response models of `/v1/today` and `/v1/overview`, and the pure functions that build them.

No I/O and no clock: the route reads rows through a `TodayReader` and hands them here.

Habit indicators (task 10b) come from the pure rules of `yawmi.domain.habits`:
* `HabitDue.period_progress`: how far the current period has come (`build_habits_due` receives
  the logs of `logs_window`: from the start of the current month or week to the day).
* `CardOut.habits`: the active habits whose `goal_ref` is the card, each with its adherence, and
  `CardOut.habits_adherence_avg`, the mean of the adherences that are not null.
"""

import re
from collections import defaultdict
from collections.abc import Iterable, Sequence
from datetime import date, timedelta
from typing import cast

from pydantic import BaseModel, Field

from yawmi.ai.schema import InsightResponse
from yawmi.domain.habits import HabitKind, HabitLog, HabitSpec, adherence, period_progress
from yawmi.domain.periods import Period, WeekStart, is_scheduled, period_bounds
from yawmi.domain.scores import DataQuality
from yawmi.habits.models import HabitUnit, domain_logs
from yawmi.habits.progress import PeriodProgressOut
from yawmi.today.reader import (
    CardRow,
    CycleRow,
    GoalRow,
    HabitRow,
    LogRow,
    MetricsRow,
    MilestoneRow,
)

TREND_DAYS = 7
_OUTCOME_CODE = re.compile(r"O([1-9]|1[0-2])")


# --- /v1/today ---------------------------------------------------------------------------------


class HabitDue(BaseModel):
    code: str
    title_ar: str
    kind: HabitKind
    unit: HabitUnit = Field(description="`''` للعادة بلا وحدة، كما في `/v1/habits`")
    target_per_period: float
    period: Period
    done_today: bool = Field(description="سُجّل لها إنجاز (`done`) اليوم من أي مصدر")
    period_progress: PeriodProgressOut = Field(
        description="تقدّم الفترة الحالية (يوم أو أسبوع أو شهر)"
    )


class TrendPoint(BaseModel):
    day: date
    recovery_score: int | None


class TodayHealth(BaseModel):
    """The day's scores and a 7-day recovery trend; a day without data is `missing`, not zero."""

    data_quality: DataQuality
    recovery_score: int | None
    strain_score: float | None
    sleep_minutes: int | None
    recovery_7d: list[TrendPoint] = Field(description="سبعة أيام تنتهي باليوم، والأقدم أولاً")


class TodayPlan(BaseModel):
    cycle: int | None = Field(description="رقم الدورة الحالية، وأسبوع مراجعتها منها")
    day_in_cycle: int | None = Field(description="1 في أول يوم من الدورة")
    focus_outcomes: list[str] = Field(description="مخرجات لها محطات مفتوحة في هذه الدورة")


class TodayOut(BaseModel):
    day: date
    habits_due: list[HabitDue]
    insight: InsightResponse | None = Field(
        description=(
            "رؤية الصباح: سطران وحتى ثلاث أولويات بمعرّفات مصادرها. `null` إلى أن تُبنى خدمة توليدها"
        )
    )
    health: TodayHealth
    plan: TodayPlan


def habit_spec(row: HabitRow) -> HabitSpec:
    return HabitSpec(
        kind=row.kind,  # type: ignore[arg-type]
        unit=row.unit,
        target_per_period=float(row.target_per_period),
        period=row.period,  # type: ignore[arg-type]
        schedule_kind=row.schedule_kind,  # type: ignore[arg-type]
        weekday_mask=row.weekday_mask,
        every_n=row.every_n,
        anchor_day=row.anchor_day,
        start_day=row.start_day,
        end_day=row.end_day,
    )


def logs_window(day: date, week_start: WeekStart) -> tuple[date, date]:
    """The days whose logs `build_habits_due` needs: from the start of the current month or
    week, whichever is earlier, to `day`."""
    week_first, _ = period_bounds(day, "week", week_start)
    return min(week_first, day.replace(day=1)), day


def _logs_by_habit(logs: Iterable[LogRow]) -> dict[str, list[HabitLog]]:
    rows: dict[str, list[LogRow]] = defaultdict(list)
    for log in logs:
        rows[log.habit_code].append(log)
    return {code: domain_logs(group) for code, group in rows.items()}


def _period_progress(
    spec: HabitSpec, logs: list[HabitLog], day: date, week_start: WeekStart
) -> PeriodProgressOut:
    p = period_progress(spec, logs, day, week_start)
    return PeriodProgressOut(
        done=p.done,
        target=p.target,
        completion=p.completion,
        reached=p.reached,
        expected=p.expected,
        on_track=p.on_track,
        need_per_day=p.need_per_day,
    )


def build_habits_due(
    day: date, habits: Iterable[HabitRow], logs: Iterable[LogRow], week_start: WeekStart
) -> list[HabitDue]:
    """Habits scheduled on `day`, in code order.

    A weekly or monthly habit is scheduled every day of its window (its target is spread over
    the period), so it is listed every day. `done_today` is true when any source logged `done`
    for it on `day`; `period_progress` is the domain's progress of the period holding `day`
    (it needs the logs of `logs_window`).
    """
    logs = list(logs)
    done = {log.habit_code for log in logs if log.day == day and log.status == "done"}
    by_habit = _logs_by_habit(logs)
    due: list[HabitDue] = []
    for row in sorted(habits, key=lambda h: h.code):
        spec = habit_spec(row)
        if not is_scheduled(day, spec):
            continue
        due.append(
            HabitDue(
                code=row.code,
                title_ar=row.title_ar,
                kind=cast(HabitKind, row.kind),
                unit=cast(HabitUnit, row.unit or ""),
                target_per_period=float(row.target_per_period),
                period=cast(Period, row.period),
                done_today=row.code in done,
                period_progress=_period_progress(spec, by_habit.get(row.code, []), day, week_start),
            )
        )
    return due


def trend_window(day: date) -> tuple[date, date]:
    return day - timedelta(days=TREND_DAYS - 1), day


def build_health(day: date, metrics: Iterable[MetricsRow]) -> TodayHealth:
    by_day = {m.day: m for m in metrics}
    first, _ = trend_window(day)
    today = by_day.get(day)
    return TodayHealth(
        data_quality=today.data_quality if today else "missing",
        recovery_score=today.recovery_score if today else None,
        strain_score=(
            float(today.strain_score) if today and today.strain_score is not None else None
        ),
        sleep_minutes=today.sleep_minutes if today else None,
        recovery_7d=[
            TrendPoint(day=d, recovery_score=by_day[d].recovery_score if d in by_day else None)
            for d in (first + timedelta(days=i) for i in range(TREND_DAYS))
        ],
    )


def outcome_number(code: str) -> int | None:
    """`O7` -> 7; `None` for anything that is not O1..O12."""
    match = _OUTCOME_CODE.fullmatch(code)
    return int(match.group(1)) if match else None


def current_cycle(day: date, cycles: Iterable[CycleRow]) -> CycleRow | None:
    """The cycle whose span, review week included, holds `day` (the lowest number on overlap)."""
    for cycle in sorted(cycles, key=lambda c: c.cycle_no):
        if cycle.start_date <= day <= cycle.review_end:
            return cycle
    return None


def build_plan(
    day: date, cycles: Iterable[CycleRow], milestones: Iterable[MilestoneRow]
) -> TodayPlan:
    cycle = current_cycle(day, cycles)
    if cycle is None:
        return TodayPlan(cycle=None, day_in_cycle=None, focus_outcomes=[])
    focus = {
        m.outcome_code
        for m in milestones
        if m.cycle_no == cycle.cycle_no
        and not m.done
        and m.outcome_code
        and outcome_number(m.outcome_code)
    }
    return TodayPlan(
        cycle=cycle.cycle_no,
        day_in_cycle=(day - cycle.start_date).days + 1,
        focus_outcomes=sorted(focus, key=lambda c: outcome_number(c) or 0),
    )


# --- /v1/overview ------------------------------------------------------------------------------


class MilestoneOut(BaseModel):
    page_id: str
    title: str
    due_date: date | None
    cycle_no: int | None


class OutcomeOut(BaseModel):
    code: str
    title: str
    target_date: date
    status: str
    milestones_total: int
    milestones_done: int
    completion: float | None = Field(description="المحطات المنجزة ÷ كل المحطات، أو null بلا محطات")
    next_milestone: MilestoneOut | None = Field(
        description="أقرب محطة مفتوحة بموعدها (ثم بالدورة)، المتأخرة منها أولاً"
    )


class CardHabit(BaseModel):
    code: str
    title_ar: str
    adherence: float | None


class CardOut(BaseModel):
    page_id: str
    title: str
    status: str | None
    outcome_codes: list[str]
    habits: list[CardHabit] = Field(
        description="العادات النشطة التي `goal_ref` فيها هذه البطاقة، بالرمز، مع التزام كل منها"
    )
    habits_adherence_avg: float | None = Field(
        description="متوسط الالتزام غير الفارغ لعادات البطاقة، أو null إن لم يوجد"
    )


class OverviewOut(BaseModel):
    outcomes: list[OutcomeOut]
    cards: list[CardOut]


def _next_key(m: MilestoneRow) -> tuple[bool, date, int, str]:
    return (m.due_date is None, m.due_date or date.max, m.cycle_no or 0, m.title)


def build_outcomes(
    goals: Iterable[GoalRow], milestones: Sequence[MilestoneRow]
) -> list[OutcomeOut]:
    """O1..O12 from `raqib.goals`, each with its milestones' completion and the next open one.

    Completion counts milestones as Notion does (done ÷ all); the habits never change it.
    """
    outcomes: list[OutcomeOut] = []
    for goal in sorted(goals, key=lambda g: outcome_number(g.code) or 0):
        if outcome_number(goal.code) is None:
            continue
        mine = [m for m in milestones if m.outcome_code == goal.code]
        done = sum(1 for m in mine if m.done)
        open_ = sorted((m for m in mine if not m.done), key=_next_key)
        nxt = open_[0] if open_ else None
        outcomes.append(
            OutcomeOut(
                code=goal.code,
                title=goal.title,
                target_date=goal.target_date,
                status=goal.status,
                milestones_total=len(mine),
                milestones_done=done,
                completion=done / len(mine) if mine else None,
                next_milestone=(
                    MilestoneOut(
                        page_id=nxt.page_id,
                        title=nxt.title,
                        due_date=nxt.due_date,
                        cycle_no=nxt.cycle_no,
                    )
                    if nxt
                    else None
                ),
            )
        )
    return outcomes


def build_cards(
    cards: Iterable[CardRow],
    habits: Iterable[HabitRow],
    logs: Iterable[LogRow],
    today: date,
    week_start: WeekStart,
) -> list[CardOut]:
    """Cards with the habits linked to them (`goal_ref` = the card's page id) and adherence.

    `habits` are the linked habits to consider (the route passes the active ones) and `logs`
    their logs up to `today`. The average leaves out habits without a finished period yet.
    """
    by_habit = _logs_by_habit(logs)
    linked: dict[str, list[CardHabit]] = defaultdict(list)
    for row in sorted(habits, key=lambda h: h.code):
        if row.goal_ref is None:
            continue
        linked[row.goal_ref].append(
            CardHabit(
                code=row.code,
                title_ar=row.title_ar,
                adherence=adherence(habit_spec(row), by_habit.get(row.code, []), today, week_start),
            )
        )
    out: list[CardOut] = []
    for c in sorted(cards, key=lambda c: (c.title, c.page_id)):
        mine = linked.get(c.page_id, [])
        values = [h.adherence for h in mine if h.adherence is not None]
        out.append(
            CardOut(
                page_id=c.page_id,
                title=c.title,
                status=c.status,
                outcome_codes=list(c.outcome_codes),
                habits=mine,
                habits_adherence_avg=sum(values) / len(values) if values else None,
            )
        )
    return out
