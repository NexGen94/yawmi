"""قواعد العادات النقية: تقدّم الفترة، القوة، السلسلة، تحدٍّ بنهاية، الالتزام، وتعبئة الهدف.

هذا التنفيذ المرجعي لمتجهات المهمة 11 (ويب وSwift يجتازان المتجهات نفسها). كل الدوال نقية
ومحدِّدة: تاريخ `date` وأعداد عشرية فقط، بلا ساعة ولا مناطق زمنية ولا حالة خارجية.

القواعد المشتركة في كل الدوال (تُثبَّت في المتجهات):

- السجلات خارج `[start_day, end_day]` وبعد `today` تُتجاهل كلياً، وترتيب السجلات لا يؤثر.
- قيمة اليوم = مجموع قيم سجلات `done` فيه. للمنطقية سجل `done` واحد أو أكثر يعني 1 (بسقف 1
  لليوم)، ولغيرها `done` بلا قيمة يعني 0.
- اليوم «متخطّى» إن كان فيه `skip` أو `vacation` وليس فيه إنجاز موجب. اليوم المتخطّى واليوم غير
  المجدول محايدان: لا ينقصان القوة، ولا يكسران السلسلة، ولا يرفعان المطلوب.
- المقارنات `done ≥ target` و`done ≥ expected` بهامش `1e-9` كي لا يُسقِط ضجيجُ الفاصلة العائمة
  (مثل 0.7 + 0.1 + 0.1 + 0.1) هدفاً تحقق فعلاً.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

from yawmi.domain.periods import Period, WeekStart, is_scheduled, iter_days, period_bounds

HabitKind = Literal["boolean", "count", "duration"]
ScheduleKind = Literal["every_day", "weekdays", "every_n_days"]
LogStatus = Literal["done", "skip", "vacation", "missed"]

_EPS = 1e-9
_ONE_DAY = timedelta(days=1)
# نصف عمر القوة: m = 0.5 ** (sqrt(f) / 13)؛ عند f = 1 تقترب القوة من 0.798 بعد 30 يوماً متتالياً.
_STRENGTH_SCALE = 13
_ROLLING_WINDOW_DAYS: dict[str, int] = {"week": 7, "month": 30}
_VALID_STATUSES = frozenset({"done", "skip", "vacation", "missed"})


@dataclass(frozen=True, slots=True)
class HabitSpec:
    """مواصفة عادة كما في جدول `yawmi.habits`، بالحقول التي تحتاجها القواعد.

    - `target_per_period` بوحدة العادة (مرة، جلسة، دقيقة، ساعة) وأكبر من الصفر.
    - `weekday_mask`: بتّ 0 = الأحد ... 6 = السبت، ومطلوب لـ`weekdays` (1..127).
    - `every_n` و`anchor_day`: مطلوبان لـ`every_n_days`.
    - `end_day`: آخر يوم في تحدٍّ بنهاية، و`None` لعادة مفتوحة.
    """

    kind: HabitKind
    unit: str | None
    target_per_period: float
    period: Period
    schedule_kind: ScheduleKind
    weekday_mask: int | None
    every_n: int | None
    anchor_day: date | None
    start_day: date
    end_day: date | None

    def __post_init__(self) -> None:
        if not self.target_per_period > 0:
            raise ValueError("الهدف لكل فترة يجب أن يكون أكبر من صفر")
        if self.schedule_kind == "weekdays" and (
            self.weekday_mask is None or not 1 <= self.weekday_mask <= 127
        ):
            raise ValueError("جدولة أيام الأسبوع تحتاج قناعاً بين 1 و127")
        if self.schedule_kind == "every_n_days" and (
            self.every_n is None or self.every_n < 1 or self.anchor_day is None
        ):
            raise ValueError("جدولة كل n يوماً تحتاج n ≥ 1 ويوم مرسى")
        if self.end_day is not None and self.end_day < self.start_day:
            raise ValueError("يوم النهاية قبل يوم البداية")


@dataclass(frozen=True, slots=True)
class HabitLog:
    """سجل يوم واحد: `value` قيمة الإنجاز (يُهمل لغير `done`)، و`status` إحدى الحالات الأربع."""

    day: date
    value: float | None
    status: LogStatus


Log = HabitLog


@dataclass(frozen=True, slots=True)
class PeriodProgress:
    """تقدّم الفترة الحالية.

    - `done`: مجموع قيم `done` في الفترة، و`completion = min(1, done / target)`.
    - `reached`: `done ≥ target`.
    - `expected = target · e / L` حيث `e` الأيام المجدولة المنقضية حتى اليوم شاملاً بلا المتخطّاة،
      و`L` كل الأيام المجدولة في الفترة. و`on_track = done ≥ expected`.
    - `need_per_day`: المتبقي من الهدف موزعاً على الأيام المجدولة الباقية شاملة اليوم.
    """

    done: float
    completion: float
    reached: bool
    expected: float
    on_track: bool
    need_per_day: float


@dataclass(frozen=True, slots=True)
class ChallengeProgress:
    """تقدّم تحدٍّ بنهاية: `achieved` من `total` و`completion` نسبتهما، و`remaining_days` شاملة اليوم."""

    achieved: int
    total: int
    completion: float
    remaining_days: int


# ---------------------------------------------------------------- أدوات داخلية


@dataclass(slots=True)
class _Day:
    """تجميع سجلات يوم واحد."""

    done: float = 0.0
    neutral: bool = False  # فيه skip أو vacation

    @property
    def skipped(self) -> bool:
        return self.neutral and self.done <= 0.0


def _done_value(spec: HabitSpec, log: HabitLog) -> float:
    if spec.kind == "boolean":
        return 1.0
    return max(0.0, float(log.value)) if log.value is not None else 0.0


def _aggregate(spec: HabitSpec, logs: Iterable[HabitLog], today: date) -> dict[date, _Day]:
    """سجلات النافذة `[start_day, min(today, end_day)]` مجمّعة باليوم."""
    days: dict[date, _Day] = {}
    for log in logs:
        if log.status not in _VALID_STATUSES:
            raise ValueError(f"حالة سجل غير معروفة: {log.status!r}")
        if log.day < spec.start_day or log.day > today:
            continue
        if spec.end_day is not None and log.day > spec.end_day:
            continue
        agg = days.setdefault(log.day, _Day())
        if log.status == "done":
            agg.done += _done_value(spec, log)
        elif log.status in ("skip", "vacation"):
            agg.neutral = True
    if spec.kind == "boolean":
        for agg in days.values():
            agg.done = min(1.0, agg.done)
    return days


def _geq(value: float, bound: float) -> bool:
    return value >= bound - _EPS


def _is_skipped(agg: _Day | None) -> bool:
    return agg is not None and agg.skipped


def _period_done(days: dict[date, _Day], start: date, end: date) -> float:
    return sum(days[day].done for day in iter_days(start, end) if day in days)


def _scheduled_days(spec: HabitSpec, start: date, end: date) -> list[date]:
    return [day for day in iter_days(start, end) if is_scheduled(day, spec)]


def _period_state(
    spec: HabitSpec, days: dict[date, _Day], start: date, end: date
) -> Literal["reached", "neutral", "missed"]:
    """حالة فترة: محققة، أو محايدة (بلا أيام مجدولة أو كلها متخطّاة)، أو فائتة."""
    scheduled = _scheduled_days(spec, start, end)
    if not scheduled:
        return "neutral"
    if _geq(_period_done(days, start, end), spec.target_per_period):
        return "reached"
    if all(_is_skipped(days.get(day)) for day in scheduled):
        return "neutral"
    return "missed"


def _next_period(end: date, period: Period, week_start: WeekStart) -> tuple[date, date]:
    return period_bounds(end + _ONE_DAY, period, week_start)


def _previous_period(start: date, period: Period, week_start: WeekStart) -> tuple[date, date]:
    return period_bounds(start - _ONE_DAY, period, week_start)


# ---------------------------------------------------------------- تقدّم الفترة


def period_progress(
    spec: HabitSpec, logs: Iterable[HabitLog], today: date, week_start: WeekStart
) -> PeriodProgress:
    """تقدّم الفترة التي تحوي `today`.

    الفترة غير المجدول يومها (أو خارج نافذة العادة) لا تتوقع شيئاً: `expected = 0` ولا مطلوب.
    اليوم المتخطّى يخفض `expected` ولا يرفع `need_per_day`، فهو يبقى بين الأيام الباقية.
    """
    days = _aggregate(spec, logs, today)
    start, end = period_bounds(today, spec.period, week_start)
    target = spec.target_per_period
    done = _period_done(days, start, end)
    scheduled = _scheduled_days(spec, start, end)
    elapsed = sum(1 for day in scheduled if day <= today and not _is_skipped(days.get(day)))
    remaining = sum(1 for day in scheduled if day >= today)
    expected = target * elapsed / len(scheduled) if scheduled else 0.0
    need_per_day = max(0.0, target - done) / remaining if remaining else 0.0
    return PeriodProgress(
        done=done,
        completion=min(1.0, done / target),
        reached=_geq(done, target),
        expected=expected,
        on_track=_geq(done, expected),
        need_per_day=need_per_day,
    )


# ---------------------------------------------------------------- القوة


def strength(
    spec: HabitSpec, logs: Iterable[HabitLog], today: date, week_start: WeekStart
) -> float:
    """قوة العادة في [0, 1] (تُعرض ×100): متوسط متحرك أُسّي من `start_day` حتى أمس.

    اليوم يدخل فقط إن كان له سجل، وبعد `end_day` تتجمد القوة. لكل يوم مجدول غير متخطّى:
    `s ← s·m + v·(1 − m)` و`m = 0.5 ** (sqrt(f) / 13)`.

    - الفترة اليومية: `f = 1`، و`v = min(1, قيمة اليوم / الهدف)`، واليوم بلا سجل أو `missed` يعطي 0.
    - الأسبوعية والشهرية: `f = الهدف / L` حيث `L` = 7 أو 30، و`v = min(1, مجموع آخر L يوماً / الهدف)`.

    `week_start` لا يؤثر هنا (نوافذ متحركة) ويبقى في التوقيع لتناظر الدوال الأخرى.
    """
    days = _aggregate(spec, logs, today)
    last = today if today in days else today - _ONE_DAY
    if spec.end_day is not None:
        last = min(last, spec.end_day)
    target = spec.target_per_period
    window = _ROLLING_WINDOW_DAYS.get(spec.period, 1)
    frequency = 1.0 if spec.period == "day" else target / window
    keep = 0.5 ** (math.sqrt(frequency) / _STRENGTH_SCALE)
    score = 0.0
    for day in iter_days(spec.start_day, last):
        if not is_scheduled(day, spec) or _is_skipped(days.get(day)):
            continue
        if spec.period == "day":
            value = days[day].done if day in days else 0.0
        else:
            value = _period_done(days, day - timedelta(days=window - 1), day)
        score = score * keep + min(1.0, value / target) * (1.0 - keep)
    return min(1.0, max(0.0, score))


# ---------------------------------------------------------------- السلسلة


def streak(spec: HabitSpec, logs: Iterable[HabitLog], today: date, week_start: WeekStart) -> int:
    """عدد الفترات المحققة المتتالية حتى الحالية.

    الفترة الفائتة غير المحققة تقطع السلسلة. والفترة المحايدة (كل أيامها المجدولة `skip`/`vacation`،
    أو لا أيام مجدولة فيها) تجسر ولا تُعد. الفترة الحالية تُعد إن تحققت، وإلا فمحايدة.
    بعد `end_day` لا فترة حالية: كل الفترات تُحكم صارمةً. قبل `start_day` السلسلة صفر.
    """
    if today < spec.start_day:
        return 0
    days = _aggregate(spec, logs, today)
    in_progress = spec.end_day is None or today <= spec.end_day
    reference = today if in_progress else spec.end_day
    assert reference is not None
    first_start, _ = period_bounds(spec.start_day, spec.period, week_start)
    start, end = period_bounds(reference, spec.period, week_start)
    count = 0
    current = in_progress
    while True:
        state = _period_state(spec, days, start, end)
        if state == "reached":
            count += 1
        elif state == "missed" and not current:
            break
        if start <= first_start:
            break
        start, end = _previous_period(start, spec.period, week_start)
        current = False
    return count


# ---------------------------------------------------------------- تحدٍّ بنهاية


def challenge_progress(
    spec: HabitSpec,
    logs: Iterable[HabitLog],
    today: date,
    week_start: WeekStart = "sun",
) -> ChallengeProgress | None:
    """تقدّم تحدٍّ لعادة لها `end_day`، و`None` لغيرها.

    - اليومية: الأيام المجدولة المحققة / الأيام المجدولة في النافذة (المتخطّاة تبقى في المقام).
    - غيرها: الفترات المحققة / الفترات المتقاطعة مع النافذة (يلزمها `week_start` للأسبوعية).
    - `remaining_days`: الأيام الباقية شاملة اليوم؛ كامل النافذة قبل البداية، و0 بعد النهاية.
    """
    if spec.end_day is None:
        return None
    days = _aggregate(spec, logs, today)
    target = spec.target_per_period
    achieved = total = 0
    if spec.period == "day":
        for day in _scheduled_days(spec, spec.start_day, spec.end_day):
            total += 1
            if day in days and _geq(days[day].done, target):
                achieved += 1
    else:
        start, end = period_bounds(spec.start_day, spec.period, week_start)
        while start <= spec.end_day:
            total += 1
            if _geq(_period_done(days, start, end), target):
                achieved += 1
            start, end = _next_period(end, spec.period, week_start)
    remaining = max(0, (spec.end_day - max(today, spec.start_day)).days + 1)
    return ChallengeProgress(
        achieved=achieved,
        total=total,
        completion=achieved / total if total else 0.0,
        remaining_days=remaining,
    )


# ---------------------------------------------------------------- الالتزام


def adherence(
    spec: HabitSpec, logs: Iterable[HabitLog], today: date, week_start: WeekStart
) -> float | None:
    """الفترات المنتهية المحققة / الفترات المنتهية غير المحايدة، و`None` إن لم تنتهِ فترة غير محايدة.

    تنتهي الفترة حين يسبق آخر يوم فيها (مقصوصاً عند `end_day`) اليومَ `today`.
    """
    days = _aggregate(spec, logs, today)
    start, end = period_bounds(spec.start_day, spec.period, week_start)
    reached = counted = 0
    while True:
        if spec.end_day is not None and start > spec.end_day:
            break
        last = end if spec.end_day is None else min(end, spec.end_day)
        if last >= today:
            break
        state = _period_state(spec, days, start, end)
        if state == "reached":
            reached += 1
        if state != "neutral":
            counted += 1
        start, end = _next_period(end, spec.period, week_start)
    return reached / counted if counted else None


# ---------------------------------------------------------------- تعبئة الهدف


def goal_prefill(
    goal_target: float,
    current: float,
    today: date,
    deadline: date,
    period: Period,
    week_start: WeekStart,
) -> int:
    """هدف الفترة المقترح لعادة تخدم هدفاً رقمياً: `max(1, ceil((G − current) / عدد الفترات))`.

    عدد الفترات من الفترة الحالية حتى فترة الموعد شاملتين (فترة واحدة على الأقل، حتى لو فات الموعد).
    """
    first, _ = period_bounds(today, period, week_start)
    last, _ = period_bounds(deadline, period, week_start)
    if period == "day":
        periods = (last - first).days + 1
    elif period == "week":
        periods = (last - first).days // 7 + 1
    else:
        periods = (last.year - first.year) * 12 + last.month - first.month + 1
    periods = max(1, periods)
    return max(1, math.ceil((goal_target - current) / periods - _EPS))
