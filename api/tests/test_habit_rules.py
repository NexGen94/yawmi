"""قواعد العادات النقية: الفترات والتقدّم والقوة والسلسلة والالتزام وتعبئة الهدف.

هذه الاختبارات هي المرجع الذي تُشتق منه متجهات المهمة 11، فكل حالة حدّية هنا مقصودة.
"""

import itertools
import math
from dataclasses import FrozenInstanceError
from datetime import date, timedelta

import pytest

from yawmi.domain.habits import (
    HabitLog,
    HabitSpec,
    Log,
    adherence,
    challenge_progress,
    goal_prefill,
    kpi_habit_shape,
    kpi_prefill_kind,
    per_period_prefill,
    period_progress,
    streak,
    strength,
)
from yawmi.domain.periods import end_day, is_scheduled, period_bounds

START = date(2026, 11, 9)  # الاثنين
SUN, MON, TUE, WED, THU, FRI, SAT = range(7)  # بتّات القناع: 0 = الأحد ... 6 = السبت
M13 = 0.5 ** (1 / 13)  # m ليوم f = 1


def d(offset: int, base: date = START) -> date:
    return base + timedelta(days=offset)


def spec(**kw) -> HabitSpec:
    base = {
        "kind": "boolean",
        "unit": None,
        "target_per_period": 1.0,
        "period": "day",
        "schedule_kind": "every_day",
        "weekday_mask": None,
        "every_n": None,
        "anchor_day": None,
        "start_day": START,
        "end_day": None,
    }
    base.update(kw)
    return HabitSpec(**base)


def count_spec(target: float, period: str, **kw) -> HabitSpec:
    return spec(kind="count", unit="session", target_per_period=target, period=period, **kw)


def done(day: date, value: float | None = 1.0) -> HabitLog:
    return HabitLog(day, value, "done")


def status(day: date, st: str) -> HabitLog:
    return HabitLog(day, None, st)


def daily_done(first: date, n: int) -> list[HabitLog]:
    return [done(d(i, first)) for i in range(n)]


def mask(*weekdays: int) -> int:
    return sum(1 << w for w in weekdays)


# ---------------------------------------------------------------- الفترات


def test_calendar_assumptions():
    assert date(2026, 11, 8).weekday() == 6  # الأحد
    assert date(2026, 11, 9).weekday() == 0  # الاثنين
    assert date(2028, 2, 29).weekday() == 1  # الثلاثاء


def test_end_day_of_a_challenge():
    assert end_day(date(2026, 11, 9), 30) == date(2026, 12, 8)
    assert end_day(date(2026, 11, 9), 1) == date(2026, 11, 9)
    assert end_day(date(2028, 2, 28), 3) == date(2028, 3, 1)  # يعبر يوم الكبيسة
    assert end_day(date(2026, 12, 30), 3) == date(2027, 1, 1)  # يعبر حدّ السنة


def test_period_bounds_day():
    assert period_bounds(date(2026, 11, 9), "day", "sun") == (date(2026, 11, 9), date(2026, 11, 9))


@pytest.mark.parametrize(
    ("week_start", "expected"),
    [
        ("sun", (date(2026, 11, 8), date(2026, 11, 14))),
        ("sat", (date(2026, 11, 7), date(2026, 11, 13))),
        ("mon", (date(2026, 11, 9), date(2026, 11, 15))),
    ],
)
def test_period_bounds_week_start_variants(week_start, expected):
    assert period_bounds(date(2026, 11, 9), "week", week_start) == expected


def test_period_bounds_week_edges():
    week = (date(2026, 11, 8), date(2026, 11, 14))
    assert period_bounds(date(2026, 11, 8), "week", "sun") == week  # يوم البداية نفسه
    assert period_bounds(date(2026, 11, 14), "week", "sun") == week  # آخر يوم
    assert period_bounds(date(2026, 11, 15), "week", "sun") == (
        date(2026, 11, 15),
        date(2026, 11, 21),
    )
    # أسبوع يعبر حدّ السنة
    assert period_bounds(date(2027, 1, 1), "week", "sun") == (date(2026, 12, 27), date(2027, 1, 2))


@pytest.mark.parametrize(
    ("day", "expected"),
    [
        (date(2026, 11, 9), (date(2026, 11, 1), date(2026, 11, 30))),
        (date(2026, 11, 1), (date(2026, 11, 1), date(2026, 11, 30))),
        (date(2026, 12, 31), (date(2026, 12, 1), date(2026, 12, 31))),
        (date(2028, 2, 29), (date(2028, 2, 1), date(2028, 2, 29))),
        (date(2027, 2, 15), (date(2027, 2, 1), date(2027, 2, 28))),
    ],
)
def test_period_bounds_month(day, expected):
    assert period_bounds(day, "month", "sun") == expected


def test_is_scheduled_every_day_respects_start_and_end():
    s = spec(end_day=d(29))
    assert not is_scheduled(d(-1), s)
    assert is_scheduled(d(0), s)
    assert is_scheduled(d(29), s)  # آخر يوم في النافذة
    assert not is_scheduled(d(30), s)  # اليوم التالي له


def test_is_scheduled_weekdays_uses_sunday_as_bit_zero():
    s = spec(schedule_kind="weekdays", weekday_mask=mask(SUN, SAT), start_day=date(2026, 11, 1))
    assert is_scheduled(date(2026, 11, 8), s)  # الأحد
    assert is_scheduled(date(2026, 11, 14), s)  # السبت
    assert not is_scheduled(date(2026, 11, 9), s)  # الاثنين
    assert not is_scheduled(date(2026, 11, 13), s)  # الجمعة


def test_is_scheduled_weekdays_still_bounded_by_window():
    s = spec(schedule_kind="weekdays", weekday_mask=127, end_day=d(2))
    assert [is_scheduled(d(i), s) for i in (-1, 0, 2, 3)] == [False, True, True, False]


def test_every_n_days_across_leap_day():
    s = spec(
        schedule_kind="every_n_days",
        every_n=3,
        anchor_day=date(2028, 2, 27),
        start_day=date(2028, 2, 20),
    )
    assert is_scheduled(date(2028, 2, 27), s)
    assert not is_scheduled(date(2028, 2, 28), s)
    assert not is_scheduled(date(2028, 2, 29), s)  # الكبيسة ليست من الدورة
    assert is_scheduled(date(2028, 3, 1), s)  # مجدولة
    assert is_scheduled(date(2028, 3, 4), s)


def test_every_n_days_anchor_after_start_counts_backwards():
    # المرسى بعد البداية: الأيام قبله مجدولة أيضاً عند المرسى − k·n
    s = spec(schedule_kind="every_n_days", every_n=3, anchor_day=d(10))
    assert [i for i in range(11) if is_scheduled(d(i), s)] == [1, 4, 7, 10]


def test_every_n_days_anchor_before_start():
    s = spec(schedule_kind="every_n_days", every_n=4, anchor_day=d(-10))
    # المجدولة: d(-10) + 4k → d(-2)، d(2)، d(6)
    assert [i for i in range(9) if is_scheduled(d(i), s)] == [2, 6]


def test_every_n_days_anchor_equals_start():
    s = spec(schedule_kind="every_n_days", every_n=2, anchor_day=START)
    assert [i for i in range(7) if is_scheduled(d(i), s)] == [0, 2, 4, 6]


@pytest.mark.parametrize(
    "kw",
    [
        {"target_per_period": 0.0},
        {"target_per_period": -1.0},
        {"schedule_kind": "weekdays", "weekday_mask": None},
        {"schedule_kind": "weekdays", "weekday_mask": 0},
        {"schedule_kind": "weekdays", "weekday_mask": 128},
        {"schedule_kind": "every_n_days", "every_n": None, "anchor_day": START},
        {"schedule_kind": "every_n_days", "every_n": 3, "anchor_day": None},
        {"schedule_kind": "every_n_days", "every_n": 0, "anchor_day": START},
        {"end_day": d(-1)},
    ],
)
def test_habit_spec_rejects_inconsistent_data(kw):
    with pytest.raises(ValueError):
        spec(**kw)


def test_habit_spec_and_log_are_frozen_and_log_alias_exists():
    s = spec()
    with pytest.raises(FrozenInstanceError):
        s.start_day = d(1)  # type: ignore[misc]
    log = done(START)
    with pytest.raises(FrozenInstanceError):
        log.value = 2.0  # type: ignore[misc]
    assert Log is HabitLog


# ---------------------------------------------------------------- القوة


def test_strength_reference_values_30_60_90_days():
    for n, expected in ((30, 0.7980), (60, 0.9592), (90, 0.9918)):
        s = strength(spec(), daily_done(START, n), d(n), "sun")
        assert abs(s - expected) < 5e-5, (n, s)
        assert math.isclose(s, 1 - M13**n, abs_tol=1e-12)


def test_strength_is_zero_with_no_history():
    assert strength(spec(), [], START, "sun") == 0.0  # اليوم الأول بلا سجل
    assert strength(spec(), [], d(10), "sun") == 0.0  # أيام فائتة كلها من الصفر


def test_strength_today_counts_only_with_a_log():
    logs = daily_done(START, 3)
    without_today = strength(spec(), logs, d(3), "sun")
    assert math.isclose(without_today, 1 - M13**3, abs_tol=1e-12)
    with_today = strength(spec(), [*logs, done(d(3))], d(3), "sun")
    assert math.isclose(with_today, 1 - M13**4, abs_tol=1e-12)
    # سجل «missed» اليوم يُحتسب صفراً صريحاً
    missed_today = strength(spec(), [*logs, status(d(3), "missed")], d(3), "sun")
    assert math.isclose(missed_today, (1 - M13**3) * M13, abs_tol=1e-12)


def test_strength_missed_and_unlogged_scheduled_days_pull_down():
    one_done_then_gap = strength(spec(), [done(START)], d(3), "sun")
    assert math.isclose(one_done_then_gap, (1 - M13) * M13**2, abs_tol=1e-12)
    explicit_missed = strength(
        spec(), [done(START), status(d(1), "missed"), status(d(2), "missed")], d(3), "sun"
    )
    assert math.isclose(explicit_missed, one_done_then_gap, abs_tol=1e-12)


@pytest.mark.parametrize("neutral", ["skip", "vacation"])
def test_strength_skip_and_vacation_leave_score_unchanged(neutral):
    with_gap = [*daily_done(START, 10), status(d(10), neutral), *daily_done(d(11), 10)]
    s = strength(spec(), with_gap, d(21), "sun")
    assert math.isclose(s, 1 - M13**20, abs_tol=1e-12)  # كأن اليوم لم يكن


@pytest.mark.parametrize("neutral", ["skip", "vacation"])
def test_strength_neutral_day_equals_not_having_the_day(neutral):
    base = strength(spec(), daily_done(START, 5), d(5), "sun")
    after = strength(spec(), [*daily_done(START, 5), status(d(5), neutral)], d(6), "sun")
    assert math.isclose(base, after, abs_tol=1e-15)
    # واليوم الحالي المتخطّى بسجل: لا تغيير أيضاً
    today = strength(spec(), [*daily_done(START, 5), status(d(5), neutral)], d(5), "sun")
    assert math.isclose(base, today, abs_tol=1e-15)


def test_strength_unscheduled_days_do_not_change_score():
    s = spec(schedule_kind="weekdays", weekday_mask=mask(MON, WED, FRI))
    # الاثنين 11-09، الأربعاء 11-11، الجمعة 11-13 مجدولة؛ ما بينها لا شيء
    logs = [done(date(2026, 11, 9)), done(date(2026, 11, 11)), done(date(2026, 11, 13))]
    got = strength(s, logs, date(2026, 11, 16), "sun")  # الاثنين التالي، اليوم بلا سجل
    assert math.isclose(got, 1 - M13**3, abs_tol=1e-12)


def test_strength_every_n_days_only_scheduled_days_update():
    s = spec(schedule_kind="every_n_days", every_n=3, anchor_day=START)
    logs = [done(d(0)), done(d(3)), done(d(6))]
    assert math.isclose(strength(s, logs, d(8), "sun"), 1 - M13**3, abs_tol=1e-12)
    # فوات يوم مجدول يخفض القوة
    gap = strength(s, [done(d(0)), done(d(6))], d(8), "sun")
    assert math.isclose(gap, (1 - M13) * M13 * M13 + (1 - M13), abs_tol=1e-12)


def test_strength_ignores_logs_before_start_day():
    early = [done(d(-5)), done(d(-1))]
    got = strength(spec(), [*early, *daily_done(START, 4)], d(4), "sun")
    assert math.isclose(got, 1 - M13**4, abs_tol=1e-12)
    assert strength(spec(), early, d(-1), "sun") == 0.0  # قبل البداية كلياً


def test_strength_duration_partial_value_is_capped_ratio():
    s = spec(kind="duration", unit="min", target_per_period=30.0)
    half = strength(s, [done(START, 15.0)], d(1), "sun")
    assert math.isclose(half, 0.5 * (1 - M13), abs_tol=1e-12)
    over = strength(s, [done(START, 90.0)], d(1), "sun")
    assert math.isclose(over, 1 - M13, abs_tol=1e-12)  # سقف 1


def test_strength_count_sums_multiple_logs_of_the_same_day():
    s = count_spec(3.0, "day")
    logs = [done(START, 1.0), done(START, 2.0)]
    assert math.isclose(strength(s, logs, d(1), "sun"), 1 - M13, abs_tol=1e-12)


def test_strength_challenge_is_frozen_after_end_day():
    s = spec(end_day=d(9))  # 10 أيام
    logs = daily_done(START, 10)
    at_end = strength(s, logs, d(9), "sun")
    after = strength(s, logs, d(30), "sun")
    assert math.isclose(at_end, after, abs_tol=1e-15)
    assert math.isclose(after, 1 - M13**10, abs_tol=1e-12)


def _rolling_expected(
    target: float,
    window: int,
    logs: dict[date, float],
    until: date,
    frequency: float | None = None,
) -> float:
    """مرجع مستقل: تحديث يومي بنافذة متحركة، و f = min(1, T / النافذة) ما لم تُمرَّر."""
    f = min(1.0, target / window) if frequency is None else frequency
    m = 0.5 ** (math.sqrt(f) / 13)
    s = 0.0
    day = START
    while day < until:
        total = sum(logs.get(day - timedelta(days=k), 0.0) for k in range(window))
        s = s * m + min(1.0, total / target) * (1 - m)
        day += timedelta(days=1)
    return s


def test_strength_weekly_rolling_window():
    values = {d(0): 1.0, d(2): 1.0, d(4): 1.0, d(9): 2.0}
    logs = [done(day, v) for day, v in values.items()]
    got = strength(count_spec(3.0, "week"), logs, d(14), "sun")
    assert math.isclose(got, _rolling_expected(3.0, 7, values, d(14)), abs_tol=1e-12)
    assert 0.0 < got < 1.0


def test_strength_weekly_window_ignores_logs_before_start_day():
    s = count_spec(3.0, "week")
    with_early = strength(s, [done(d(-1), 3.0), done(d(0), 1.0)], d(1), "sun")
    without = strength(s, [done(d(0), 1.0)], d(1), "sun")
    assert with_early == without


def test_strength_monthly_rolling_window():
    values = {d(i): 1.0 for i in range(0, 20, 2)}
    logs = [done(day, v) for day, v in values.items()]
    got = strength(count_spec(10.0, "month"), logs, d(40), "sun")
    assert math.isclose(got, _rolling_expected(10.0, 30, values, d(40)), abs_tol=1e-12)


def test_strength_weekly_skip_days_do_not_update():
    s = count_spec(3.0, "week")
    base = strength(s, [done(START, 3.0)], d(3), "sun")
    with_skip = strength(s, [done(START, 3.0), status(d(3), "vacation")], d(4), "sun")
    assert math.isclose(base, with_skip, abs_tol=1e-15)


def test_strength_stays_within_unit_interval_and_ignores_week_start():
    s = spec(kind="duration", unit="min", target_per_period=20.0)
    logs = [done(d(i), 5.0 * (i % 7)) for i in range(60)]
    for ws in ("sat", "sun", "mon"):
        assert 0.0 <= strength(s, logs, d(60), ws) <= 1.0
    assert strength(s, logs, d(60), "sat") == strength(s, logs, d(60), "mon")


def test_strength_ignores_future_dated_logs_and_input_order():
    expected = strength(spec(), daily_done(START, 5), d(5), "sun")
    assert strength(spec(), [*daily_done(START, 5), done(d(9))], d(5), "sun") == expected
    assert strength(spec(), list(reversed(daily_done(START, 5))), d(5), "sun") == expected


# ---------------------------------------------------------------- تقدّم الفترة


def test_period_progress_daily_boolean_not_yet_done():
    p = period_progress(spec(), [], START, "sun")
    assert (p.done, p.completion, p.reached) == (0.0, 0.0, False)
    assert p.target == 1.0
    assert p.expected == 0.0  # صباحاً قبل التسجيل: اليوم لا يُحسب منقضياً بعد
    assert p.on_track is True
    assert p.need_per_day == 1.0  # لكنه ما زال بين الأيام الباقية


def test_period_progress_daily_boolean_done():
    p = period_progress(spec(), [done(START)], START, "sun")
    assert (p.done, p.completion, p.reached) == (1.0, 1.0, True)
    assert p.on_track is True
    assert p.need_per_day == 0.0


def test_period_progress_boolean_two_logs_same_day_count_once():
    p = period_progress(spec(), [done(START), done(START)], START, "sun")
    assert p.done == 1.0
    assert p.completion == 1.0


@pytest.mark.parametrize("neutral", ["skip", "vacation"])
def test_period_progress_daily_skip_expects_nothing(neutral):
    p = period_progress(spec(), [status(START, neutral)], START, "sun")
    assert p.done == 0.0
    assert p.expected == 0.0
    assert p.on_track is True


def test_period_progress_unscheduled_day_demands_nothing():
    s = spec(schedule_kind="weekdays", weekday_mask=mask(WED))
    p = period_progress(s, [], START, "sun")  # الاثنين غير مجدول
    assert p.expected == 0.0
    assert p.on_track is True
    assert p.need_per_day == 0.0
    assert p.reached is False


def test_period_progress_duration_partial():
    s = spec(kind="duration", unit="min", target_per_period=30.0)
    p = period_progress(s, [done(START, 10.0), done(START, 5.0)], START, "sun")
    assert p.done == 15.0
    assert p.completion == 0.5
    assert p.reached is False
    assert p.need_per_day == 15.0


def test_period_progress_overshoot_caps_completion_at_one():
    p = period_progress(count_spec(2.0, "day"), [done(START, 5.0)], START, "sun")
    assert p.done == 5.0
    assert p.completion == 1.0
    assert p.reached is True
    assert p.need_per_day == 0.0


def test_period_progress_weekly_mid_week():
    # الأسبوع الأحد 11-08 ... السبت 11-14؛ اليوم الأربعاء 11-11
    s = count_spec(5.0, "week", start_day=date(2026, 11, 1))
    logs = [done(date(2026, 11, 8)), done(date(2026, 11, 9)), done(date(2026, 11, 10))]
    p = period_progress(s, logs, date(2026, 11, 11), "sun")
    assert p.done == 3.0
    assert p.completion == pytest.approx(0.6)
    assert p.reached is False
    assert p.expected == pytest.approx(5 * 3 / 7)  # أحد، اثنين، ثلاثاء؛ والأربعاء بلا سجل
    assert p.on_track is True
    assert p.need_per_day == pytest.approx(2 / 4)  # الأربعاء إلى السبت شاملاً


def test_period_progress_weekly_vacation_day_lowers_expected_not_need():
    s = count_spec(5.0, "week", start_day=date(2026, 11, 1))
    logs = [
        done(date(2026, 11, 8)),
        status(date(2026, 11, 9), "vacation"),
        done(date(2026, 11, 10)),
    ]
    p = period_progress(s, logs, date(2026, 11, 11), "sun")
    assert p.expected == pytest.approx(5 * 2 / 7)  # الأحد والثلاثاء؛ الإجازة لا تُحسب منقضية
    assert p.need_per_day == pytest.approx((5 - 2) / 4)  # والمطلوب اليومي لا يرتفع بسببه


def test_period_progress_weekly_behind_schedule():
    s = count_spec(7.0, "week", start_day=date(2026, 11, 1))
    p = period_progress(s, [done(date(2026, 11, 8))], date(2026, 11, 13), "sun")  # الجمعة
    assert p.expected == pytest.approx(7 * 5 / 7)  # من الأحد إلى الخميس؛ والجمعة بلا سجل
    assert p.on_track is False
    assert p.need_per_day == pytest.approx(6 / 2)  # الجمعة والسبت


def test_period_progress_ignores_logs_outside_the_period():
    s = count_spec(5.0, "week", start_day=date(2026, 10, 1))
    logs = [done(date(2026, 11, 7)), done(date(2026, 11, 8)), done(date(2026, 11, 15))]
    p = period_progress(s, logs, date(2026, 11, 10), "sun")
    assert p.done == 1.0  # 11-07 من الأسبوع السابق، و11-15 بعد اليوم وخارج الفترة


def test_period_progress_ignores_logs_before_start_day():
    # البداية الاثنين 11-09 وسجل الأحد 11-08 من الأسبوع نفسه لكنه قبل البداية
    s = count_spec(5.0, "week", start_day=START)
    logs = [done(date(2026, 11, 8)), done(START)]
    p = period_progress(s, logs, date(2026, 11, 10), "sun")
    assert p.done == 1.0
    assert p.target == 5.0  # 6 من 7 أيام: ceil(5 · 6/7) = 5
    assert p.expected == pytest.approx(5 * 1 / 6)  # الاثنين فقط؛ الأيام المجدولة في الفترة 6


def test_period_progress_week_start_changes_the_period():
    s = count_spec(5.0, "week", start_day=date(2026, 10, 1))
    logs = [done(date(2026, 11, 7)), done(date(2026, 11, 8))]
    today = date(2026, 11, 10)
    assert period_progress(s, logs, today, "sun").done == 1.0
    assert period_progress(s, logs, today, "sat").done == 2.0  # السبت 11-07 بداية الأسبوع
    assert period_progress(s, logs, today, "mon").done == 0.0  # الاثنين 11-09 بداية الأسبوع


def test_period_progress_monthly_in_leap_february():
    s = count_spec(29.0, "month", start_day=date(2028, 1, 1))
    logs = [done(date(2028, 2, i + 1)) for i in range(10)]
    p = period_progress(s, logs, date(2028, 2, 29), "sun")
    assert p.done == 10.0
    assert p.expected == pytest.approx(28.0)  # 28 يوماً منقضياً من 29؛ واليوم الأخير بلا سجل
    assert p.on_track is False
    assert p.need_per_day == pytest.approx(19.0)  # اليوم الأخير وحده


def test_period_progress_monthly_prorates_expected():
    s = count_spec(30.0, "month", start_day=date(2026, 11, 1))
    p = period_progress(s, [], date(2026, 11, 15), "sun")
    assert p.expected == pytest.approx(30 * 14 / 30)  # 14 يوماً منقضياً؛ واليوم 15 بلا سجل
    assert p.need_per_day == pytest.approx(30 / 16)  # من 15 إلى 30 نوفمبر شاملاً


def test_period_progress_before_start_day():
    p = period_progress(spec(), [], d(-3), "sun")
    assert p.done == 0.0
    assert p.reached is False
    assert p.need_per_day == 0.0


def test_period_progress_outside_challenge_window():
    s = spec(end_day=d(4))
    p = period_progress(s, [done(d(6))], d(6), "sun")  # بعد النافذة: السجل لا يُحسب
    assert p.done == 0.0
    assert p.need_per_day == 0.0


def test_period_progress_float_sum_reaches_target_exactly():
    s = spec(kind="duration", unit="hour", target_per_period=1.0)
    logs = [done(START, 0.7), done(START, 0.1), done(START, 0.1), done(START, 0.1)]
    p = period_progress(s, logs, START, "sun")
    assert p.reached is True  # 0.7+0.1+0.1+0.1 = 0.9999999999999999 في الفاصلة العائمة
    assert p.completion == pytest.approx(1.0)


def test_period_progress_done_without_value():
    boolean = period_progress(spec(), [done(START, None)], START, "sun")
    assert boolean.done == 1.0  # المنطقية: done يعني 1
    duration = spec(kind="duration", unit="min", target_per_period=30.0)
    assert period_progress(duration, [done(START, None)], START, "sun").done == 0.0


# ---------------------------------------------------------------- السلسلة


def test_streak_before_start_is_zero():
    assert streak(spec(), daily_done(START, 3), d(-1), "sun") == 0


def test_streak_counts_today_when_reached():
    assert streak(spec(), daily_done(START, 5), d(4), "sun") == 5


def test_streak_today_unlogged_is_neutral_not_breaking():
    assert streak(spec(), daily_done(START, 4), d(4), "sun") == 4


def test_streak_breaks_on_a_missed_past_day():
    logs = [done(d(0)), done(d(1)), done(d(3))]  # اليوم 2 فائت
    assert streak(spec(), logs, d(3), "sun") == 1


def test_streak_explicit_missed_log_breaks_too():
    logs = [done(d(0)), status(d(1), "missed"), done(d(2))]
    assert streak(spec(), logs, d(2), "sun") == 1


@pytest.mark.parametrize("neutral", ["skip", "vacation"])
def test_streak_skip_and_vacation_days_bridge_without_counting(neutral):
    logs = [done(d(0)), done(d(1)), status(d(2), neutral), done(d(3)), done(d(4))]
    assert streak(spec(), logs, d(4), "sun") == 4  # اليوم المتخطّى لا يُعد


def test_streak_unscheduled_days_bridge():
    s = spec(schedule_kind="weekdays", weekday_mask=mask(MON, WED, FRI))
    logs = [done(date(2026, 11, 9)), done(date(2026, 11, 11)), done(date(2026, 11, 13))]
    assert streak(s, logs, date(2026, 11, 14), "sun") == 3  # السبت غير مجدول
    assert streak(s, logs, date(2026, 11, 15), "sun") == 3  # الأحد غير مجدول أيضاً


def test_streak_every_n_days_only_scheduled_days_matter():
    s = spec(schedule_kind="every_n_days", every_n=3, anchor_day=START)
    logs = [done(d(0)), done(d(3)), done(d(6))]
    assert streak(s, logs, d(8), "sun") == 3
    assert streak(s, [done(d(0)), done(d(6))], d(8), "sun") == 1  # فاتت d(3)


def test_streak_challenge_complete_and_after_end():
    s = spec(end_day=d(2))
    logs = daily_done(START, 3)
    assert streak(s, logs, d(2), "sun") == 3  # آخر يوم
    assert streak(s, logs, d(20), "sun") == 3  # بعد الانتهاء
    # اليوم الأخير فائت: بعد الانتهاء يُحكم عليه صارماً
    assert streak(s, daily_done(START, 2), d(3), "sun") == 0
    # ويوم النهاية نفسه يبقى «الحالي» فلا يكسر
    assert streak(s, daily_done(START, 2), d(2), "sun") == 2


WEEK1 = date(2026, 11, 1)  # الأحد؛ أسابيع الأحد: 11-01، 11-08، 11-15، 11-22


def weekly_spec() -> HabitSpec:
    return count_spec(3.0, "week", start_day=WEEK1)


def week_done(week_start: date, n: int = 3) -> list[HabitLog]:
    return [done(d(i, week_start)) for i in range(n)]


def week_status(week_start: date, st: str, n: int = 7) -> list[HabitLog]:
    return [status(d(i, week_start), st) for i in range(n)]


def test_streak_weekly_counts_reached_weeks():
    logs = [*week_done(date(2026, 11, 1)), *week_done(date(2026, 11, 8))]
    assert streak(weekly_spec(), logs, date(2026, 11, 16), "sun") == 2  # الحالي لم يتحقق: محايد


def test_streak_weekly_current_week_counts_once_reached():
    logs = [
        *week_done(date(2026, 11, 1)),
        *week_done(date(2026, 11, 8)),
        *week_done(date(2026, 11, 15)),
    ]
    assert streak(weekly_spec(), logs, date(2026, 11, 17), "sun") == 3


def test_streak_all_vacation_week_bridges_and_is_not_counted():
    logs = [
        *week_done(date(2026, 11, 1)),
        *week_status(date(2026, 11, 8), "vacation"),
        *week_done(date(2026, 11, 15)),
        done(date(2026, 11, 22)),  # الأسبوع الحالي لم يتحقق بعد
    ]
    assert streak(weekly_spec(), logs, date(2026, 11, 23), "sun") == 2


def test_streak_all_skip_week_bridges_too():
    logs = [
        *week_done(date(2026, 11, 1)),
        *week_status(date(2026, 11, 8), "skip"),
        *week_done(date(2026, 11, 15)),
    ]
    assert streak(weekly_spec(), logs, date(2026, 11, 23), "sun") == 2


def test_streak_week_without_logs_breaks():
    logs = [*week_done(date(2026, 11, 1)), *week_done(date(2026, 11, 15))]
    assert streak(weekly_spec(), logs, date(2026, 11, 23), "sun") == 1


def test_streak_partially_vacationed_week_is_not_neutral():
    logs = [
        *week_done(date(2026, 11, 1)),
        *week_status(date(2026, 11, 8), "vacation", n=6),  # يوم واحد بلا سجل
        *week_done(date(2026, 11, 15)),
    ]
    assert streak(weekly_spec(), logs, date(2026, 11, 23), "sun") == 1


def test_streak_monthly():
    s = count_spec(2.0, "month", start_day=date(2026, 9, 1))
    logs = [
        done(date(2026, 9, 3)),
        done(date(2026, 9, 20)),
        *[status(date(2026, 10, i), "vacation") for i in range(1, 32)],
        done(date(2026, 11, 2)),
        done(date(2026, 11, 5)),
    ]
    assert streak(s, logs, date(2026, 11, 9), "sun") == 2  # سبتمبر + نوفمبر الحالي، وأكتوبر محايد


def test_streak_ignores_future_logs():
    logs = [*daily_done(START, 3), done(d(5))]
    assert streak(spec(), logs, d(2), "sun") == 3


# ---------------------------------------------------------------- تحدٍّ بنهاية


def test_challenge_progress_none_without_end_day():
    assert challenge_progress(spec(), daily_done(START, 5), d(5)) is None


def test_challenge_progress_daily():
    s = spec(end_day=end_day(START, 30))
    c = challenge_progress(s, daily_done(START, 10), d(11))
    assert c is not None
    assert (c.achieved, c.total) == (10, 30)
    assert c.completion == pytest.approx(10 / 30)
    assert c.remaining_days == 19  # من 11-20 إلى 12-08 شاملاً اليوم


def test_challenge_progress_remaining_days_boundaries():
    s = spec(end_day=end_day(START, 30))  # 2026-12-08

    def remaining(today: date) -> int:
        c = challenge_progress(s, [], today)
        assert c is not None
        return c.remaining_days

    assert remaining(d(-8)) == 30  # قبل البداية: كامل النافذة
    assert remaining(START) == 30
    assert remaining(date(2026, 12, 7)) == 2
    assert remaining(date(2026, 12, 8)) == 1  # يوم النهاية
    assert remaining(date(2026, 12, 9)) == 0  # اليوم التالي
    assert remaining(date(2027, 3, 1)) == 0


def test_challenge_progress_skip_days_stay_in_denominator():
    s = spec(end_day=d(9))
    logs = [done(d(0)), status(d(1), "skip"), status(d(2), "vacation")]
    c = challenge_progress(s, logs, d(3))
    assert c is not None
    assert (c.achieved, c.total) == (1, 10)


def test_challenge_progress_daily_counts_only_scheduled_days():
    # 11-09 .. 11-22: اثنان وثلاثاء في أسبوعين = 4 أيام مجدولة
    s = spec(schedule_kind="weekdays", weekday_mask=mask(MON, TUE), end_day=d(13))
    c = challenge_progress(s, [done(d(0)), done(d(1))], d(5))
    assert c is not None
    assert (c.achieved, c.total) == (2, 4)


def test_challenge_progress_daily_duration_needs_full_target():
    s = spec(kind="duration", unit="min", target_per_period=30.0, end_day=d(2))
    c = challenge_progress(s, [done(d(0), 30.0), done(d(1), 29.0)], d(2))
    assert c is not None
    assert (c.achieved, c.total) == (1, 3)


def test_challenge_progress_weekly_counts_intersecting_periods():
    # النافذة 11-09 .. 11-30: أسابيع الأحد 11-08 و11-15 و11-22 و11-29 = 4 فترات متقاطعة
    s = count_spec(2.0, "week", end_day=date(2026, 11, 30))
    logs = [done(date(2026, 11, 9)), done(date(2026, 11, 10)), done(date(2026, 11, 16))]
    c = challenge_progress(s, logs, date(2026, 11, 20), "sun")
    assert c is not None
    assert (c.achieved, c.total) == (1, 4)
    assert c.remaining_days == 11
    # أسابيع الاثنين: 11-09 و11-16 و11-23 و11-30، ويتحقق الأول وحده (11-09 و11-10)
    mon = challenge_progress(s, logs, date(2026, 11, 20), "mon")
    assert mon is not None
    assert (mon.achieved, mon.total) == (1, 4)


def test_challenge_progress_monthly_periods():
    s = count_spec(1.0, "month", start_day=date(2026, 11, 9), end_day=date(2027, 1, 20))
    logs = [done(date(2026, 11, 15)), done(date(2026, 12, 3))]
    c = challenge_progress(s, logs, date(2026, 12, 10))
    assert c is not None
    assert (c.achieved, c.total) == (2, 3)  # نوفمبر وديسمبر ويناير


# ---------------------------------------------------------------- الالتزام


def test_adherence_none_before_first_ended_period():
    assert adherence(spec(), [done(START)], START, "sun") is None
    assert adherence(spec(), [], d(-5), "sun") is None


def test_adherence_after_first_day():
    assert adherence(spec(), [done(START)], d(1), "sun") == 1.0
    assert adherence(spec(), [], d(1), "sun") == 0.0


def test_adherence_ratio_of_ended_periods_only():
    logs = [done(d(0)), done(d(1)), done(d(3))]  # اليوم 2 فائت
    assert adherence(spec(), logs, d(4), "sun") == pytest.approx(0.75)  # اليوم 4 لم ينتهِ


def test_adherence_skip_vacation_and_unscheduled_are_excluded():
    logs = [done(d(0)), status(d(1), "skip")]
    assert adherence(spec(), logs, d(3), "sun") == pytest.approx(0.5)  # يوم 0 محقق، يوم 2 فائت
    s = spec(schedule_kind="weekdays", weekday_mask=mask(MON, TUE))
    assert adherence(s, [done(d(0))], d(4), "sun") == pytest.approx(0.5)  # الاثنين والثلاثاء فقط


def test_adherence_all_neutral_is_none():
    logs = [status(d(0), "vacation"), status(d(1), "skip")]
    assert adherence(spec(), logs, d(2), "sun") is None


def test_adherence_weekly():
    logs = [*week_done(date(2026, 11, 1)), done(date(2026, 11, 8))]
    assert adherence(weekly_spec(), logs, date(2026, 11, 16), "sun") == pytest.approx(0.5)
    assert adherence(weekly_spec(), logs, date(2026, 11, 7), "sun") is None  # الأول لم ينتهِ
    assert adherence(weekly_spec(), logs, date(2026, 11, 8), "sun") == 1.0


def test_adherence_weekly_vacation_week_excluded():
    logs = [*week_done(date(2026, 11, 1)), *week_status(date(2026, 11, 8), "vacation")]
    assert adherence(weekly_spec(), logs, date(2026, 11, 16), "sun") == 1.0


def test_adherence_covers_the_whole_challenge_after_it_ends():
    s = spec(end_day=d(2))
    logs = [done(d(0)), done(d(1))]  # اليوم 2 فائت
    assert adherence(s, logs, d(2), "sun") == 1.0  # يوم النهاية لم ينتهِ بعد
    assert adherence(s, logs, d(3), "sun") == pytest.approx(2 / 3)
    assert adherence(s, logs, d(50), "sun") == pytest.approx(2 / 3)


# ---------------------------------------------------------------- تعبئة الهدف


def test_goal_prefill_binding_value():
    assert goal_prefill(100, 40, date(2026, 11, 9), date(2026, 12, 31), "week", "sun") == 8


def test_goal_prefill_week_start_changes_period_count():
    sat, sun = date(2026, 11, 14), date(2026, 11, 15)
    assert goal_prefill(10, 0, sat, sun, "week", "sun") == 5  # فترتان
    assert goal_prefill(10, 0, sat, sun, "week", "sat") == 10  # فترة واحدة
    assert goal_prefill(10, 0, sat, sun, "week", "mon") == 10  # الأسبوع 11-09 .. 11-15


def test_goal_prefill_day_and_month():
    assert (
        goal_prefill(100, 40, date(2026, 11, 9), date(2026, 11, 18), "day", "sun") == 6
    )  # 10 أيام
    assert (
        goal_prefill(100, 40, date(2026, 11, 9), date(2027, 1, 31), "month", "sun") == 20
    )  # 3 أشهر
    assert (
        goal_prefill(100, 40, date(2026, 11, 30), date(2026, 12, 1), "month", "sun") == 30
    )  # شهران


def test_goal_prefill_rounds_up_and_has_floor_of_one():
    assert goal_prefill(10, 0, date(2026, 11, 9), date(2026, 11, 11), "day", "sun") == 4  # 10 / 3
    assert goal_prefill(100, 100, date(2026, 11, 9), date(2026, 12, 31), "week", "sun") == 1
    assert goal_prefill(100, 150, date(2026, 11, 9), date(2026, 12, 31), "week", "sun") == 1


def test_goal_prefill_deadline_today_or_past_is_one_period():
    assert goal_prefill(100, 40, date(2026, 11, 9), date(2026, 11, 9), "day", "sun") == 60
    assert goal_prefill(100, 40, date(2026, 11, 9), date(2026, 11, 1), "week", "sun") == 60
    assert goal_prefill(100, 40, date(2026, 11, 9), date(2026, 10, 1), "month", "sun") == 60


def test_goal_prefill_float_noise_does_not_round_up():
    # 2.2 − 1.2 = 1.0000000000000002 في الفاصلة العائمة، والمطلوب 1
    assert goal_prefill(2.2, 1.2, date(2026, 11, 9), date(2026, 11, 9), "day", "sun") == 1


# ---------------------------------------------------------------- تعبئة الهدف بحسب نوع المؤشر
# مؤشرات البذرة كما في `raqib/memory-seed.json`:
# (code, unit, direction, target, frequency)
SEED_KPIS = [
    ("weight_kg", "كجم", "band", None, "weekly"),
    ("steps_avg", "خطوة", "up", 8000, "weekly"),
    ("strength_sessions", "جلسة", "up", 2, "weekly"),
    ("sleep_7h_nights", "ليلة", "up", 5, "weekly"),
    ("who5_raw", "نقطة", "up", 13, "monthly"),
    ("clarity_score", "1–10", "up", 8, "monthly"),
    ("reply_rate_pct", "%", "up", 80, "weekly"),
    ("plan_adherence_pct", "%", "up", 80, "weekly"),
    ("measured_projects", "مشروع", "up", 5, "cycle"),
    ("english_minutes", "دقيقة", "up", 285, "weekly"),
    ("english_speaking", "جلسة", "up", 2, "weekly"),
    ("journal_morning_days", "يوم", "up", 5, "weekly"),
    ("journal_evening_days", "يوم", "up", 5, "weekly"),
    ("top3_done_pct", "%", "up", 70, "weekly"),
    ("meditation_days", "يوم", "up", 5, "weekly"),
    ("visualization_days", "يوم", "up", 5, "weekly"),
    ("consumer_debt_sar", "ريال", "down", 0, "monthly"),
    ("emergency_months", "شهر", "up", 6, "monthly"),
    ("savings_rate_pct", "%", "up", 20, "monthly"),
    ("side_income_sar", "ريال", "up", 6000, "monthly"),
    ("social_initiations", "مبادرة", "up", 2, "weekly"),
    ("family_halfday", "نعم/لا", "up", 1, "weekly"),
    ("workshops_count", "ورشة", "up", 20, "cycle"),
    ("books_done", "كتاب", "up", 12, "monthly"),
]
EXPECTED_KIND = {
    "weight_kg": "none",  # نطاق
    "steps_avg": "none",  # متوسط
    "strength_sessions": "per_period",
    "sleep_7h_nights": "per_period",
    "who5_raw": "none",  # مستوى
    "clarity_score": "none",  # مستوى
    "reply_rate_pct": "none",  # نسبة
    "plan_adherence_pct": "none",
    "measured_projects": "cumulative",
    "english_minutes": "per_period",
    "english_speaking": "per_period",
    "journal_morning_days": "per_period",
    "journal_evening_days": "per_period",
    "top3_done_pct": "none",
    "meditation_days": "per_period",
    "visualization_days": "per_period",
    "consumer_debt_sar": "none",  # اتجاه نازل
    "emergency_months": "none",  # مستوى: أشهر مدّخرة
    "savings_rate_pct": "none",
    "side_income_sar": "none",  # مال لا فعل يتكرر
    "social_initiations": "per_period",
    "family_halfday": "per_period",
    "workshops_count": "cumulative",
    "books_done": "cumulative",
}


@pytest.mark.parametrize(("code", "unit", "direction", "target", "frequency"), SEED_KPIS)
def test_every_seeded_kpi_has_its_prefill_kind(code, unit, direction, target, frequency):
    assert kpi_prefill_kind(code, direction, unit, target, frequency) == EXPECTED_KIND[code]


def test_the_cumulative_set_is_explicit_and_beats_its_frequency():
    # books_done is monthly in the mirror, yet its 12 is a total by the deadline, not 12 a month
    assert kpi_prefill_kind("books_done", "up", "كتاب", 12, "monthly") == "cumulative"
    assert kpi_prefill_kind("measured_projects", "up", "مشروع", 5, "cycle") == "cumulative"
    # an unknown code with the same shape is a per-period count, not cumulative
    assert kpi_prefill_kind("books_read", "up", "كتاب", 12, "monthly") == "per_period"


def test_a_cumulative_kpi_without_a_single_target_has_no_prefill():
    assert kpi_prefill_kind("books_done", "up", "كتاب", None, "monthly") == "none"


@pytest.mark.parametrize(
    ("code", "unit", "direction", "target", "frequency"),
    [
        ("x_count", "مرة", "down", 3, "weekly"),  # نازل
        ("x_count", "مرة", "band", 3, "weekly"),  # نطاق
        ("x_count", "مرة", "up", None, "weekly"),  # بلا هدف واحد
        ("x_count", "مرة", "up", 3, "cycle"),  # تواتر الدورة ليس فترة عادة
        ("x_count", "%", "up", 3, "weekly"),  # وحدة النسبة
        ("x_count", " % ", "up", 3, "weekly"),
        ("x_pct", "مرة", "up", 3, "weekly"),  # رمز نسبة
        ("steps_avg", "مرة", "up", 3, "weekly"),
        ("weight_kg", "كجم", "up", 80, "weekly"),
        ("who5_raw", "نقطة", "up", 13, "monthly"),
        ("clarity_score", "1–10", "up", 8, "monthly"),
        ("emergency_months", "شهر", "up", 6, "monthly"),  # مستوى
        ("side_income_sar", "ريال", "up", 6000, "monthly"),  # مال
    ],
)
def test_rates_averages_levels_and_non_up_kpis_have_no_prefill(
    code, unit, direction, target, frequency
):
    assert kpi_prefill_kind(code, direction, unit, target, frequency) == "none"


@pytest.mark.parametrize(
    ("frequency", "period"), [("daily", "day"), ("weekly", "week"), ("monthly", "month")]
)
def test_a_per_period_kpi_prefills_its_own_target_when_the_periods_match(frequency, period):
    assert per_period_prefill(285, frequency, period) == 285.0


@pytest.mark.parametrize(
    ("unit", "shape"),
    [
        ("دقيقة", ("duration", "min")),  # english_minutes: 285 دقيقة في الأسبوع
        (" دقيقة ", ("duration", "min")),
        ("جلسة", ("count", "session")),  # strength_sessions, english_speaking
        ("ليلة", ("count", "")),  # لا وحدة عادة تقابلها
        ("يوم", ("count", "")),
        ("مبادرة", ("count", "")),
        ("نعم/لا", ("count", "")),
        ("", ("count", "")),
        (None, ("count", "")),
    ],
)
def test_a_per_period_draft_takes_its_kind_and_unit_from_the_kpi_unit(unit, shape):
    assert kpi_habit_shape(unit) == shape


@pytest.mark.parametrize(
    ("frequency", "period"),
    [
        ("weekly", "month"),  # english_minutes weekly vs a monthly habit
        ("weekly", "day"),
        ("monthly", "week"),
        ("daily", "week"),
        ("cycle", "month"),
    ],
)
def test_a_per_period_kpi_has_no_prefill_when_the_periods_differ(frequency, period):
    assert per_period_prefill(285, frequency, period) is None


# ---------------------------------------------------------------- نقاء الدوال


def test_functions_do_not_mutate_inputs_and_are_deterministic():
    logs = [done(d(2)), done(d(0)), status(d(1), "skip")]
    snapshot = list(logs)
    s = spec()

    def run():
        return (
            period_progress(s, logs, d(3), "sun"),
            strength(s, logs, d(3), "sun"),
            streak(s, logs, d(3), "sun"),
            adherence(s, logs, d(3), "sun"),
        )

    assert run() == run()
    assert logs == snapshot


def test_functions_accept_any_iterable_of_logs():
    gen = (done(d(i)) for i in range(3))
    assert streak(spec(), gen, d(3), "sun") == 3


# ---------------------------------------------------------------- اليوم الحالي قبل التسجيل (R3)


def test_period_progress_today_enters_expected_only_with_a_log():
    s = count_spec(5.0, "week", start_day=date(2026, 11, 1))
    earlier = [done(date(2026, 11, 8)), done(date(2026, 11, 9)), done(date(2026, 11, 10))]
    today = date(2026, 11, 11)  # الأربعاء
    without = period_progress(s, earlier, today, "sun")
    assert without.expected == pytest.approx(5 * 3 / 7)
    with_done = period_progress(s, [*earlier, done(today)], today, "sun")
    assert with_done.expected == pytest.approx(5 * 4 / 7)
    with_missed = period_progress(s, [*earlier, status(today, "missed")], today, "sun")
    assert with_missed.expected == pytest.approx(5 * 4 / 7)  # أي سجل يكفي
    with_skip = period_progress(s, [*earlier, status(today, "skip")], today, "sun")
    assert with_skip.expected == pytest.approx(5 * 3 / 7)  # والمتخطّى لا يُحسب
    # والباقي شاملاً اليوم في كل الحالات
    assert without.need_per_day == pytest.approx((5 - 3) / 4)
    assert with_missed.need_per_day == pytest.approx((5 - 3) / 4)


def test_period_progress_daily_partial_log_today_is_expected_to_finish():
    s = spec(kind="duration", unit="min", target_per_period=30.0)
    p = period_progress(s, [done(START, 15.0)], START, "sun")
    assert p.expected == 30.0  # للسجل اليوم صار منقضياً
    assert p.on_track is False
    assert p.need_per_day == 15.0


# ---------------------------------------------------------------- الفترات الجزئية (R1)

THURSDAY = date(2026, 11, 12)  # أسبوع الأحد 11-08 .. 11-14: المجدول منه الخميس والجمعة والسبت


def weekly_bool(**kw) -> HabitSpec:
    return spec(kind="boolean", target_per_period=5.0, period="week", **kw)


def test_partial_first_week_has_prorated_target_and_is_reached():
    s = weekly_bool(start_day=THURSDAY)
    logs = [done(date(2026, 11, 12)), done(date(2026, 11, 13)), done(date(2026, 11, 14))]
    p = period_progress(s, logs, date(2026, 11, 14), "sun")
    assert p.target == 3.0  # ceil(5 · 3/7)
    assert p.reached is True
    assert p.completion == 1.0
    short = period_progress(s, logs[:2], date(2026, 11, 14), "sun")
    assert short.reached is False
    assert short.completion == pytest.approx(2 / 3)


def test_partial_first_week_adherence_and_streak_after_a_full_second_week():
    s = weekly_bool(start_day=THURSDAY)
    week1 = [done(date(2026, 11, i)) for i in (12, 13, 14)]
    week2 = [done(date(2026, 11, i)) for i in (15, 16, 17, 18, 19)]
    # أول فترة منتهية: الأسبوع الجزئي محقق بهدفه المتناسب
    assert adherence(s, week1, date(2026, 11, 15), "sun") == 1.0
    # بعد أسبوع كامل ثانٍ
    assert adherence(s, [*week1, *week2], date(2026, 11, 22), "sun") == 1.0
    assert streak(s, [*week1, *week2], date(2026, 11, 22), "sun") == 2
    # أسبوع ثانٍ ناقص يخفض الالتزام ويقطع السلسلة
    short2 = week2[:4]
    assert adherence(s, [*week1, *short2], date(2026, 11, 22), "sun") == 0.5
    assert streak(s, [*week1, *short2], date(2026, 11, 22), "sun") == 0


def test_thirty_day_weekly_challenge_from_sunday_is_fully_met():
    start = date(2026, 11, 8)  # الأحد
    last = end_day(start, 30)  # 2026-12-07
    s = weekly_bool(start_day=start, end_day=last)
    logs = [done(d(i, start)) for i in range(30)]
    today = date(2026, 12, 8)
    assert streak(s, logs, today, "sun") == 5
    assert adherence(s, logs, today, "sun") == 1.0
    c = challenge_progress(s, logs, today, "sun")
    assert c is not None
    assert (c.achieved, c.total, c.completion, c.remaining_days) == (5, 5, 1.0, 0)
    # الفترة الأخيرة (12-06 و12-07) مقصوصة بالنهاية: ceil(5 · 2/7) = 2
    p = period_progress(s, logs, last, "sun")
    assert (p.target, p.done, p.reached) == (2.0, 2.0, True)


def test_partial_end_period_is_judged_strictly_by_its_prorated_target():
    start = date(2026, 11, 8)
    s = weekly_bool(start_day=start, end_day=end_day(start, 30))
    logs = [done(d(i, start)) for i in range(29)]  # ينقص يوم النهاية 12-07
    today = date(2026, 12, 8)
    assert streak(s, logs, today, "sun") == 0  # الفترة الأخيرة فائتة (1 من 2)
    assert adherence(s, logs, today, "sun") == pytest.approx(4 / 5)
    c = challenge_progress(s, logs, today, "sun")
    assert c is not None
    assert (c.achieved, c.total) == (4, 5)


def test_monthly_partial_start_prorates_by_month_length():
    s = count_spec(10.0, "month", start_day=date(2026, 11, 21))  # 10 من 30 يوماً
    logs = [done(date(2026, 11, 21 + i)) for i in range(4)]
    p = period_progress(s, logs, date(2026, 11, 30), "sun")
    assert p.target == 4.0  # ceil(10 · 10/30)
    assert p.reached is True
    # والشهر الكامل التالي بهدفه كاملاً
    assert period_progress(s, [], date(2026, 12, 5), "sun").target == 10.0


def test_monthly_challenge_partial_months_use_prorated_targets():
    s = count_spec(10.0, "month", start_day=date(2026, 11, 21), end_day=date(2027, 1, 10))
    logs = [
        *[done(date(2026, 11, 21 + i)) for i in range(4)],  # نوفمبر: 4 من 4
        *[done(date(2026, 12, 1 + i)) for i in range(10)],  # ديسمبر: 10 من 10
        *[done(date(2027, 1, 1 + i)) for i in range(4)],  # يناير 10 من 31: ceil(3.2) = 4
    ]
    c = challenge_progress(s, logs, date(2027, 1, 12), "sun")
    assert c is not None
    assert (c.achieved, c.total) == (3, 3)


def test_prorated_target_rounds_up_and_ignores_float_noise():
    duration = spec(
        kind="duration", unit="min", target_per_period=285.0, period="week", start_day=THURSDAY
    )
    p = period_progress(duration, [], date(2026, 11, 12), "sun")
    assert p.target == 123.0  # ceil(285 · 3/7) = ceil(122.14)
    noisy = count_spec(14.000000001, "week", start_day=THURSDAY)
    # 14.000000001 · 3/7 = 6.0000000004 → 6 لا 7
    assert period_progress(noisy, [], date(2026, 11, 12), "sun").target == 6.0
    tiny = count_spec(2.0, "week", start_day=date(2026, 11, 14))  # يوم واحد من 7
    assert period_progress(tiny, [], date(2026, 11, 14), "sun").target == 1.0


def test_prorated_target_never_exceeds_the_habit_target():
    # هدف 0.5 ساعة أسبوعياً في أسبوع جزئي: التناسب لا يرفعه إلى 1
    half = spec(
        kind="duration",
        unit="hour",
        target_per_period=0.5,
        period="week",
        start_day=THURSDAY,
    )
    p = period_progress(half, [done(THURSDAY, 0.5)], date(2026, 11, 14), "sun")
    assert p.target == 0.5
    assert p.reached is True
    assert adherence(half, [done(THURSDAY, 0.5)], date(2026, 11, 15), "sun") == 1.0
    # وهدف 1 أو أكثر لا يتغير بالسقف: ceil(2 · 1/7) = 1 ≤ 2، وceil(5 · 3/7) = 3 ≤ 5
    assert (
        period_progress(count_spec(1.0, "week", start_day=THURSDAY), [], THURSDAY, "sun").target
        == 1.0
    )
    assert period_progress(weekly_bool(start_day=THURSDAY), [], THURSDAY, "sun").target == 3.0


def test_full_and_daily_periods_keep_the_raw_target():
    full = count_spec(2.5, "week", start_day=date(2026, 11, 1))
    assert period_progress(full, [], date(2026, 11, 11), "sun").target == 2.5  # بلا تقريب
    daily = count_spec(3.0, "day", start_day=THURSDAY)  # الهدف يسري على كل يوم مجدول
    assert period_progress(daily, [], date(2026, 11, 12), "sun").target == 3.0
    outside = count_spec(5.0, "week", start_day=date(2026, 11, 22))  # الفترة قبل البداية كلياً
    assert period_progress(outside, [], date(2026, 11, 11), "sun").target == 5.0


def test_partial_week_with_all_days_skipped_stays_neutral():
    s = weekly_bool(start_day=THURSDAY)
    logs = [status(date(2026, 11, i), "vacation") for i in (12, 13, 14)]
    assert adherence(s, logs, date(2026, 11, 15), "sun") is None


# ---------------------------------------------------------------- سرعة القوة لا تتبع الوحدة (R2)


def test_strength_weekly_duration_speed_is_unit_independent():
    # 285 دقيقة في أسبوع كامل: السرعة كاليومية (f = 1) لا 285/7
    s = spec(kind="duration", unit="min", target_per_period=285.0, period="week")
    got = strength(s, [done(START, 285.0)], d(7), "sun")
    assert math.isclose(got, 1 - M13**7, abs_tol=1e-12)
    hours = spec(kind="duration", unit="hour", target_per_period=5.0, period="week")
    assert math.isclose(strength(hours, [done(START, 5.0)], d(7), "sun"), got, abs_tol=1e-12)


def test_strength_weekly_count_keeps_fractional_frequency():
    s = count_spec(5.0, "week")
    m = 0.5 ** (math.sqrt(5 / 7) / 13)
    got = strength(s, [done(START, 5.0)], d(7), "sun")
    assert math.isclose(got, 1 - m**7, abs_tol=1e-12)
    assert got < 1 - M13**7  # أبطأ من اليومية


def test_strength_weekly_boolean_frequency_is_target_over_window():
    s = spec(kind="boolean", target_per_period=3.0, period="week")
    values = {d(0): 1.0, d(1): 1.0, d(2): 1.0}
    logs = [done(day) for day in values]
    got = strength(s, logs, d(7), "sun")
    assert math.isclose(
        got, _rolling_expected(3.0, 7, values, d(7), frequency=3 / 7), abs_tol=1e-12
    )


def test_strength_frequency_is_capped_at_one_when_target_exceeds_window():
    s = count_spec(60.0, "month")  # 60 / 30 = 2 → f = 1
    got = strength(s, [done(START, 60.0)], d(30), "sun")
    assert math.isclose(got, 1 - M13**30, abs_tol=1e-12)
    duration = spec(kind="duration", unit="min", target_per_period=600.0, period="month")
    got = strength(duration, [done(START, 600.0)], d(30), "sun")
    assert math.isclose(got, 1 - M13**30, abs_tol=1e-12)


# ---------------------------------------------------------------- تفاصيل ثانوية


def test_progress_numbers_are_always_floats():
    for s in (spec(), count_spec(3.0, "day"), count_spec(3.0, "week"), count_spec(3.0, "month")):
        p = period_progress(s, [], START, "sun")
        for value in (p.done, p.target, p.completion, p.expected, p.need_per_day):
            assert isinstance(value, float)
    integer_target = HabitSpec(
        "count", "session", 3, "day", "every_day", None, None, None, START, None
    )
    p = period_progress(integer_target, [done(START, 1)], START, "sun")
    assert all(isinstance(v, float) for v in (p.done, p.target, p.completion, p.need_per_day))


def test_same_day_float_sum_is_independent_of_input_order():
    s = spec(kind="duration", unit="hour", target_per_period=1.0)
    values = [0.1, 0.2, 0.3]  # 0.1+0.2+0.3 ≠ 0.3+0.2+0.1 بالترتيب العشوائي
    results = set()
    for order in itertools.permutations(values):
        p = period_progress(s, [done(START, v) for v in order], START, "sun")
        results.add(p.done)
    assert len(results) == 1


@pytest.mark.parametrize(
    "kw",
    [
        {"kind": "text"},
        {"period": "year"},
        {"schedule_kind": "monthly"},
        {"period": "week", "schedule_kind": "weekdays", "weekday_mask": 5},
        {"period": "month", "schedule_kind": "every_n_days", "every_n": 2, "anchor_day": START},
    ],
)
def test_habit_spec_rejects_unknown_enums_and_non_daily_schedules_for_week_month(kw):
    with pytest.raises(ValueError):
        spec(**kw)


@pytest.mark.parametrize("bad", ["tue", "", "SUN"])
def test_unknown_week_start_is_rejected_everywhere(bad):
    s = spec(end_day=d(30))
    with pytest.raises(ValueError):
        period_bounds(START, "week", bad)
    with pytest.raises(ValueError):
        period_bounds(START, "day", bad)
    with pytest.raises(ValueError):
        period_bounds(START, "month", bad)
    with pytest.raises(ValueError):
        period_progress(s, [], START, bad)
    with pytest.raises(ValueError):
        strength(s, [], START, bad)
    with pytest.raises(ValueError):
        streak(s, [], START, bad)
    with pytest.raises(ValueError):
        streak(s, [], d(-5), bad)  # حتى قبل البداية
    with pytest.raises(ValueError):
        adherence(s, [], START, bad)
    with pytest.raises(ValueError):
        challenge_progress(s, [], START, bad)
    with pytest.raises(ValueError):
        challenge_progress(spec(), [], START, bad)  # حتى بلا نهاية
    with pytest.raises(ValueError):
        goal_prefill(10, 0, START, d(5), "day", bad)


@pytest.mark.parametrize("n", [0, -1, -30])
def test_end_day_requires_at_least_one_day(n):
    with pytest.raises(ValueError):
        end_day(START, n)


def test_goal_prefill_epsilon_applies_to_the_quotient():
    today, deadline = START, d(6)  # سبعة أيام
    assert goal_prefill(56, 0, today, deadline, "day", "sun") == 8
    # 56.000000004 / 7 = 8.00000000057 ثم ceil(x − 1e-9) يعطي 8
    assert goal_prefill(56.000000004, 0, today, deadline, "day", "sun") == 8
    assert goal_prefill(56.0000000035, 0, today, deadline, "day", "sun") == 8  # 8.0000000005
    # وفوق الهامش يُقرَّب لأعلى: 56.00000002 / 7 = 8.0000000029
    assert goal_prefill(56.00000002, 0, today, deadline, "day", "sun") == 9


@pytest.mark.parametrize("n", [1, 0, -2])
def test_every_n_days_needs_n_of_two_or_more(n):
    """`every_n = 1` is `every_day`; the database refuses it (`every_n >= 2`), so the spec does."""
    with pytest.raises(ValueError):
        spec(schedule_kind="every_n_days", every_n=n, anchor_day=START)
    assert spec(schedule_kind="every_n_days", every_n=2, anchor_day=START).every_n == 2


# ---------------------------------------------------------------- عادة الامتناع (rulesVersion 2، التصميم §9.6)

ABSTAIN_START = date(2026, 11, 1)
ABSTAIN_TODAY = date(2026, 11, 10)
ABSTAIN_END = date(2026, 11, 30)


def abstain(**kw) -> HabitSpec:
    return spec(polarity="abstain", start_day=ABSTAIN_START, **kw)


def slip(day: date) -> HabitLog:
    """في عادة الامتناع سجل `done` المخزَّن معناه انزلاق."""
    return done(day)


# P1..P4 من جدول التصميم §9.6: (السجلات، adherence، streak، strength، تقدّم اليوم done/reached)
ABSTAIN_EXAMPLES = {
    "abstain-clean": ([], 1.0, 10, 0.413270, 1.0, True),
    "abstain-slip-mid": ([slip(date(2026, 11, 5))], 0.9, 5, 0.373498, 1.0, True),
    "abstain-slip-today": ([slip(ABSTAIN_TODAY)], 0.9, 0, 0.361347, 0.0, False),
    "abstain-skip-neutral": ([status(date(2026, 11, 5), "skip")], 1.0, 9, 0.381137, 1.0, True),
}


def test_habit_spec_polarity_defaults_to_build():
    assert spec().polarity == "build"
    assert abstain().polarity == "abstain"


@pytest.mark.parametrize("name", list(ABSTAIN_EXAMPLES))
def test_abstain_design_examples(name):
    logs, adh, stk, stren, today_done, today_reached = ABSTAIN_EXAMPLES[name]
    habit = abstain()
    assert adherence(habit, logs, ABSTAIN_TODAY, "sun") == pytest.approx(adh, abs=1e-12)
    assert streak(habit, logs, ABSTAIN_TODAY, "sun") == stk
    assert strength(habit, logs, ABSTAIN_TODAY, "sun") == pytest.approx(stren, abs=1e-6)
    progress = period_progress(habit, logs, ABSTAIN_TODAY, "sun")
    assert progress.done == today_done
    assert progress.reached is today_reached
    assert progress.target == 1.0
    assert progress.expected == 1.0


def test_abstain_today_is_kept_until_a_slip_is_logged():
    """اليوم لا يقف «معلّقاً»: بلا انزلاق محفوظ، وبانزلاق فائت، و`expected = 1` في الحالين."""
    clean = period_progress(abstain(), [], ABSTAIN_TODAY, "sun")
    assert (clean.done, clean.reached, clean.on_track, clean.need_per_day) == (1.0, True, True, 0.0)
    slipped = period_progress(abstain(), [slip(ABSTAIN_TODAY)], ABSTAIN_TODAY, "sun")
    assert (slipped.done, slipped.reached, slipped.on_track) == (0.0, False, False)
    assert slipped.completion == 0.0
    assert slipped.need_per_day == 1.0


def test_abstain_challenge_counts_kept_days_and_remaining_after_today():
    habit = abstain(end_day=ABSTAIN_END)
    clean = challenge_progress(habit, [], ABSTAIN_TODAY, "sun")
    assert clean is not None
    assert (clean.achieved, clean.total, clean.remaining_days) == (10, 30, 20)
    assert clean.completion == pytest.approx(10 / 30)
    mid = challenge_progress(habit, [slip(date(2026, 11, 5))], ABSTAIN_TODAY, "sun")
    assert mid is not None
    assert mid.achieved == 9


@pytest.mark.parametrize(
    "kw",
    [
        {"kind": "count", "unit": "session"},
        {"kind": "duration", "unit": "min"},
        {"target_per_period": 2.0},
        {"target_per_period": 0.5},
        {"period": "week"},
        {"period": "month"},
    ],
)
def test_abstain_must_be_a_daily_boolean_with_target_one(kw):
    with pytest.raises(ValueError):
        abstain(**kw)


@pytest.mark.parametrize("bad", ["", "ABSTAIN", "quit", None])
def test_unknown_polarity_is_rejected(bad):
    with pytest.raises(ValueError):
        spec(polarity=bad)


def _kept_days_as_build(habit: HabitSpec, logs: list[HabitLog], today: date) -> list[HabitLog]:
    """عادة البناء المكافئة: `done` في كل يوم مجدول محفوظ حتى `today`، و`skip`/`vacation` كما هي."""
    last = today if habit.end_day is None else min(today, habit.end_day)
    slips = {log.day for log in logs if log.status == "done"}
    neutral = [log for log in logs if log.status in ("skip", "vacation")]
    neutral_days = {log.day for log in neutral}
    kept = [
        done(day)
        for day in (
            habit.start_day + timedelta(days=i) for i in range((last - habit.start_day).days + 1)
        )
        if is_scheduled(day, habit) and day not in slips and day not in neutral_days
    ]
    return kept + neutral


_SLIP_SETS = {
    "first-day": [date(2026, 11, 1)],
    "middle": [date(2026, 11, 15)],
    "last-day": [date(2026, 11, 30)],
    "three-slips": [date(2026, 11, 3), date(2026, 11, 15), date(2026, 11, 28)],
    "slips-and-skips": [date(2026, 11, 7), date(2026, 11, 20), date(2026, 11, 21)],
}


@pytest.mark.parametrize("end", [ABSTAIN_END, None], ids=["challenge", "open"])
@pytest.mark.parametrize("slips", list(_SLIP_SETS))
@pytest.mark.parametrize("week_start", ["sat", "sun", "mon"])
def test_abstain_at_t_equals_build_on_kept_days_at_t_plus_one(end, slips, week_start):
    """الصيغة المكافئة في §9.6: لكل `T` من قبل البداية إلى ما بعد النهاية، الدوال الأربع لعادة
    امتناع عند `T` تساوي ناتج عادة بناء لها `done` في الأيام المحفوظة، محسوبةً عند `T + 1`."""
    habit = abstain(end_day=end)
    twin = spec(start_day=ABSTAIN_START, end_day=end)
    logs = [slip(day) for day in _SLIP_SETS[slips]]
    if slips == "slips-and-skips":
        logs += [status(date(2026, 11, 12), "skip"), status(date(2026, 11, 25), "vacation")]
    for offset in range(-2, 34):
        today = ABSTAIN_START + timedelta(days=offset)
        build_logs = _kept_days_as_build(habit, logs, today)
        tomorrow = today + timedelta(days=1)
        assert strength(habit, logs, today, week_start) == strength(
            twin, build_logs, tomorrow, week_start
        ), today
        assert streak(habit, logs, today, week_start) == streak(
            twin, build_logs, tomorrow, week_start
        ), today
        assert adherence(habit, logs, today, week_start) == adherence(
            twin, build_logs, tomorrow, week_start
        ), today
        assert challenge_progress(habit, logs, today, week_start) == challenge_progress(
            twin, build_logs, tomorrow, week_start
        ), today


def test_abstain_on_a_weekday_schedule_keeps_only_scheduled_days():
    """الجدولة لا يقيّدها الامتناع: الأيام غير المجدولة محايدة كما في البناء."""
    habit = abstain(schedule_kind="weekdays", weekday_mask=mask(SUN, TUE, THU))
    # 11-01 الأحد .. 11-10 الثلاثاء: المجدولة 11-01 و11-03 و11-05 و11-08 و11-10
    assert streak(habit, [], ABSTAIN_TODAY, "sun") == 5
    assert adherence(habit, [slip(date(2026, 11, 4))], ABSTAIN_TODAY, "sun") == 1.0  # الأربعاء
    assert adherence(habit, [slip(date(2026, 11, 5))], ABSTAIN_TODAY, "sun") == pytest.approx(0.8)


def test_build_habits_are_unchanged_by_polarity_default():
    logs = daily_done(START, 5)
    explicit = spec(polarity="build")
    assert strength(explicit, logs, d(5), "sun") == strength(spec(), logs, d(5), "sun")
    assert period_progress(explicit, logs, d(4), "sun") == period_progress(
        spec(), logs, d(4), "sun"
    )


# ---------------------------------------------------------------- الامتناع: أحكام التنفيذ (جولة الإصلاح 1)

_SKIP_TODAY = {
    "done": 0.0,
    "target": 1.0,
    "completion": 0.0,
    "reached": False,
    "expected": 0.0,
    "on_track": True,
    "need_per_day": 1.0,
}
_CLEAN_TODAY = {
    "done": 1.0,
    "target": 1.0,
    "completion": 1.0,
    "reached": True,
    "expected": 1.0,
    "on_track": True,
    "need_per_day": 0.0,
}
_MON_WED_FRI = mask(MON, WED, FRI)  # 42؛ اليوم 2026-11-10 ثلاثاء غير مجدول
_UNSCHEDULED_TODAY = {
    "done": 0.0,
    "target": 1.0,
    "completion": 0.0,
    "reached": False,
    "expected": 0.0,
    "on_track": True,
    "need_per_day": 0.0,
}

# (المواصفة، السجلات، تقدّم اليوم، streak، adherence، strength بهامش 1e-6)
ABSTAIN_DECIDED = {
    # skip أو vacation اليوم محايد كما في عادة البناء: لا محفوظ ولا انزلاق (حكم المتحكم، جولة 1)
    "skip-today": ({}, [status(ABSTAIN_TODAY, "skip")], _SKIP_TODAY, 9, 1.0, 0.381137),
    "vacation-today": ({}, [status(ABSTAIN_TODAY, "vacation")], _SKIP_TODAY, 9, 1.0, 0.381137),
    # سجل missed ليس انزلاقاً: اليوم محفوظ ما لم يُسجَّل `done`
    "missed-today": ({}, [status(ABSTAIN_TODAY, "missed")], _CLEAN_TODAY, 10, 1.0, 0.413270),
    # انزلاق وتخطٍّ في اليوم نفسه: التخطي يجعله محايداً (التصحيح بتخطي اليوم)
    "slip-and-skip-today": (
        {},
        [slip(ABSTAIN_TODAY), status(ABSTAIN_TODAY, "skip")],
        _SKIP_TODAY,
        9,
        1.0,
        0.381137,
    ),
    # الأيام غير المجدولة لا تُحسب محفوظة، والانزلاق فيها لا أثر له
    "weekdays-no-logs": (
        {"schedule_kind": "weekdays", "weekday_mask": _MON_WED_FRI},
        [],
        _UNSCHEDULED_TODAY,
        4,
        1.0,
        0.192067,
    ),
    "weekdays-slip-saturday": (
        {"schedule_kind": "weekdays", "weekday_mask": _MON_WED_FRI},
        [slip(date(2026, 11, 7))],
        _UNSCHEDULED_TODAY,
        4,
        1.0,
        0.192067,
    ),
    "weekdays-slip-today-unscheduled": (
        {"schedule_kind": "weekdays", "weekday_mask": _MON_WED_FRI},
        [slip(ABSTAIN_TODAY)],
        _UNSCHEDULED_TODAY,
        4,
        1.0,
        0.192067,
    ),
}


@pytest.mark.parametrize("name", list(ABSTAIN_DECIDED))
def test_abstain_decided_behaviours(name):
    kw, logs, today_progress, stk, adh, stren = ABSTAIN_DECIDED[name]
    habit = abstain(**kw)
    progress = period_progress(habit, logs, ABSTAIN_TODAY, "sun")
    assert {
        "done": progress.done,
        "target": progress.target,
        "completion": progress.completion,
        "reached": progress.reached,
        "expected": progress.expected,
        "on_track": progress.on_track,
        "need_per_day": progress.need_per_day,
    } == today_progress
    assert streak(habit, logs, ABSTAIN_TODAY, "sun") == stk
    assert adherence(habit, logs, ABSTAIN_TODAY, "sun") == pytest.approx(adh, abs=1e-12)
    assert strength(habit, logs, ABSTAIN_TODAY, "sun") == pytest.approx(stren, abs=1e-6)
