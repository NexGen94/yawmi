"""قواعد العادات النقية: الفترات والتقدّم والقوة والسلسلة والالتزام وتعبئة الهدف.

هذه الاختبارات هي المرجع الذي تُشتق منه متجهات المهمة 11، فكل حالة حدّية هنا مقصودة.
"""

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


def _rolling_expected(target: float, window: int, logs: dict[date, float], until: date) -> float:
    """مرجع مستقل: تحديث يومي بنافذة متحركة، و f = T / النافذة."""
    m = 0.5 ** (math.sqrt(target / window) / 13)
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
    assert p.expected == 1.0
    assert p.on_track is False
    assert p.need_per_day == 1.0


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
    assert p.expected == pytest.approx(5 * 4 / 7)  # أحد، اثنين، ثلاثاء، أربعاء
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
    assert p.expected == pytest.approx(5 * 3 / 7)  # يوم الإجازة لا يُحسب منقضياً
    assert p.need_per_day == pytest.approx((5 - 2) / 4)  # والمطلوب اليومي لا يرتفع بسببه


def test_period_progress_weekly_behind_schedule():
    s = count_spec(7.0, "week", start_day=date(2026, 11, 1))
    p = period_progress(s, [done(date(2026, 11, 8))], date(2026, 11, 13), "sun")  # الجمعة
    assert p.expected == pytest.approx(7 * 6 / 7)
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
    assert p.expected == pytest.approx(5 * 2 / 6)  # الأيام المجدولة في الفترة 6 (من الاثنين)


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
    assert p.expected == pytest.approx(29.0)  # 29 يوماً منقضياً من 29
    assert p.on_track is False
    assert p.need_per_day == pytest.approx(19.0)  # اليوم الأخير وحده


def test_period_progress_monthly_prorates_expected():
    s = count_spec(30.0, "month", start_day=date(2026, 11, 1))
    p = period_progress(s, [], date(2026, 11, 15), "sun")
    assert p.expected == pytest.approx(30 * 15 / 30)
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
