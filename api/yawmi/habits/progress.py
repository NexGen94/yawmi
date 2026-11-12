"""The indicators of `GET /v1/habits/{code}/progress`, from the pure rules of `yawmi.domain`.

Nothing is re-derived here: period progress (with the prorated target of a clipped week or
month), strength, streak, challenge and adherence are the domain functions as they are. This
module only picks the reference day and lays out the last periods.
"""

from collections.abc import Sequence
from datetime import date, timedelta
from typing import Self

from pydantic import BaseModel, Field

from yawmi.domain.habits import (
    HabitLog,
    HabitSpec,
    PeriodProgress,
    adherence,
    challenge_progress,
    period_progress,
    streak,
    strength,
)
from yawmi.domain.periods import WeekStart, is_scheduled, period_bounds
from yawmi.habits.store import StoredHabit

LAST_PERIODS = 8


class PeriodProgressOut(BaseModel):
    done: float
    target: float = Field(
        description="هدف الفترة؛ متناسب في أسبوع أو شهر مقصوص بالبداية أو النهاية"
    )
    completion: float
    reached: bool
    expected: float
    on_track: bool
    need_per_day: float | None = Field(
        description="المطلوب يومياً لبلوغ الهدف؛ `null` لعادة امتناع فلا معنى له"
    )

    @classmethod
    def of(cls, p: PeriodProgress, spec: HabitSpec) -> Self:
        return cls(
            done=p.done,
            target=p.target,
            completion=p.completion,
            reached=p.reached,
            expected=p.expected,
            on_track=p.on_track,
            need_per_day=None if spec.polarity == "abstain" else p.need_per_day,
        )


class ChallengeOut(BaseModel):
    achieved: int
    total: int
    completion: float
    remaining_days: int


class ProgressOut(BaseModel):
    period_progress: PeriodProgressOut
    strength: float = Field(description="0–1، وتُعرض ×100")
    streak: int
    challenge: ChallengeOut | None = Field(description="لعادة لها `end_day` فقط")
    adherence: float | None = Field(description="null قبل أول فترة منتهية")
    total_done: float = Field(
        description=(
            "مجموع قيم `done` منذ بداية العادة (عدد أيام الإنجاز للمنطقية)؛ ولعادة الامتناع عدد "
            "الأيام المجدولة النظيفة (بلا انزلاق ولا تخطٍّ ولا إجازة) حتى اليوم"
        )
    )
    last_8_periods: list[float] = Field(
        description=(
            "نسبة إنجاز آخر 8 فترات، الأقدم أولاً وآخرها الفترة الحالية؛ تُسقط الفترات المنتهية "
            "قبل `start_day` فقد تقل عن 8"
        )
    )


def spec_of(habit: StoredHabit) -> HabitSpec:
    return HabitSpec(
        kind=habit.kind,  # type: ignore[arg-type]
        unit=habit.unit,
        target_per_period=float(habit.target_per_period),
        period=habit.period,  # type: ignore[arg-type]
        schedule_kind=habit.schedule_kind,  # type: ignore[arg-type]
        weekday_mask=habit.weekday_mask,
        every_n=habit.every_n,
        anchor_day=habit.anchor_day,
        start_day=habit.start_day,
        end_day=habit.end_day,
        polarity=habit.polarity,  # type: ignore[arg-type]
    )


def total_done_of(spec: HabitSpec, logs: Sequence[HabitLog], today: date) -> float:
    """The habit's running total in `[start_day, min(today, end_day)]`.

    A build habit: the sum of `done` values (the count of `done` days for a boolean). An abstain
    habit: a `done` log is a slip, so the total is the scheduled days that are clean, with no slip,
    no skip and no vacation (design 9.6): a slip lowers it, it never raises it.
    """
    last = today if spec.end_day is None else min(today, spec.end_day)
    if spec.polarity == "abstain":
        logged = {lg.day for lg in logs if spec.start_day <= lg.day <= last}
        clean = 0
        day = spec.start_day
        while day <= last:
            if day not in logged and is_scheduled(day, spec):
                clean += 1
            day += timedelta(days=1)
        return float(clean)
    in_window = [lg for lg in logs if lg.status == "done" and spec.start_day <= lg.day <= last]
    if spec.kind == "boolean":
        return float(len({lg.day for lg in in_window}))
    return float(sum(lg.value or 0.0 for lg in in_window))


def last_periods(
    spec: HabitSpec,
    logs: Sequence[HabitLog],
    today: date,
    week_start: WeekStart,
    count: int = LAST_PERIODS,
) -> list[float]:
    """Completion of up to `count` periods ending with the current one, oldest first.

    The current period is judged at `today`, a past one at its last day. After `end_day` the
    period of `end_day` is the last one. Periods that end before `start_day` are left out.
    """
    reference = today if spec.end_day is None else min(today, spec.end_day)
    start, end = period_bounds(reference, spec.period, week_start)
    at = reference
    out: list[float] = []
    while len(out) < count and end >= spec.start_day:
        out.append(period_progress(spec, logs, at, week_start).completion)
        start, end = period_bounds(start - timedelta(days=1), spec.period, week_start)
        at = end
    return out[::-1]


def progress(
    habit: StoredHabit, logs: Sequence[HabitLog], today: date, week_start: WeekStart
) -> ProgressOut:
    spec = spec_of(habit)
    current = period_progress(spec, logs, today, week_start)
    challenge = challenge_progress(spec, logs, today, week_start)
    return ProgressOut(
        period_progress=PeriodProgressOut.of(current, spec),
        strength=strength(spec, logs, today, week_start),
        streak=streak(spec, logs, today, week_start),
        challenge=None
        if challenge is None
        else ChallengeOut(
            achieved=challenge.achieved,
            total=challenge.total,
            completion=challenge.completion,
            remaining_days=challenge.remaining_days,
        ),
        adherence=adherence(spec, logs, today, week_start),
        total_done=total_done_of(spec, logs, today),
        last_8_periods=last_periods(spec, logs, today, week_start),
    )
