"""حدود الفترات وجدولة الأيام للعادات.

دوال نقية على `datetime.date` وحدها: بلا مناطق زمنية ولا ساعة نظام. اليوم المحلي بتوقيت
`Asia/Riyadh` يُحسب خارج هذه الوحدة ويصلها تاريخاً جاهزاً. هذا التنفيذ المرجعي الذي تُشتق منه
متجهات المهمة 11 للويب وSwift، فلا تُضف قاعدة هنا دون اختبارها في `test_habit_rules.py`.
"""

from __future__ import annotations

import calendar
from collections.abc import Iterator
from datetime import date, timedelta
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from yawmi.domain.habits import HabitSpec

Period = Literal["day", "week", "month"]
WeekStart = Literal["sat", "sun", "mon"]

# `date.weekday()`: الاثنين 0 ... الأحد 6
_WEEK_START_WEEKDAY: dict[str, int] = {"mon": 0, "sat": 5, "sun": 6}
_ONE_DAY = timedelta(days=1)


def end_day(start: date, duration_days: int) -> date:
    """آخر يوم في تحدٍّ مدته `duration_days` يوماً: `start + duration_days − 1`، والبداية يوم أول."""
    return start + timedelta(days=duration_days - 1)


def iter_days(start: date, end: date) -> Iterator[date]:
    """الأيام من `start` إلى `end` شاملين، وتنتهي فوراً إن كانت `end` قبل `start`."""
    day = start
    while day <= end:
        yield day
        day += _ONE_DAY


def weekday_bit(day: date) -> int:
    """رقم بتّ اليوم في قناع أيام الأسبوع: 0 = الأحد ... 6 = السبت، كما في قيد قاعدة البيانات."""
    return (day.weekday() + 1) % 7


def period_bounds(day: date, period: Period, week_start: WeekStart) -> tuple[date, date]:
    """بداية الفترة التي تحوي `day` ونهايتها، شاملتين.

    - `day`: اليوم نفسه.
    - `week`: تبدأ في أحدث يوم يطابق `week_start` (`sat` أو `sun` أو `mon`) وتمتد سبعة أيام.
    - `month`: من أول الشهر الميلادي إلى آخره، وفبراير الكبيسة 29 يوماً.
    """
    if period == "day":
        return day, day
    if period == "week":
        offset = (day.weekday() - _WEEK_START_WEEKDAY[week_start]) % 7
        start = day - timedelta(days=offset)
        return start, start + timedelta(days=6)
    if period == "month":
        last = calendar.monthrange(day.year, day.month)[1]
        return day.replace(day=1), day.replace(day=last)
    raise ValueError(f"فترة غير معروفة: {period!r}")


def is_scheduled(day: date, spec: HabitSpec) -> bool:
    """هل `day` مجدول للعادة؟

    الأيام خارج `[start_day, end_day]` غير مجدولة أبداً. وداخلها:
    - `every_day`: كل يوم.
    - `weekdays`: إن كان بتّ يوم الأسبوع مضبوطاً في `weekday_mask` (0 = الأحد ... 6 = السبت).
    - `every_n_days`: إن كان `(day − anchor_day).days % every_n == 0`، والمرسى قد يسبق البداية
      أو يليها، فالأيام قبل المرسى مجدولة أيضاً عند المرسى − k·n.
    """
    if day < spec.start_day:
        return False
    if spec.end_day is not None and day > spec.end_day:
        return False
    if spec.schedule_kind == "every_day":
        return True
    if spec.schedule_kind == "weekdays":
        assert spec.weekday_mask is not None  # يضمنه HabitSpec
        return bool(spec.weekday_mask & (1 << weekday_bit(day)))
    if spec.schedule_kind == "every_n_days":
        assert spec.every_n is not None and spec.anchor_day is not None  # يضمنه HabitSpec
        return (day - spec.anchor_day).days % spec.every_n == 0
    raise ValueError(f"نوع جدولة غير معروف: {spec.schedule_kind!r}")
