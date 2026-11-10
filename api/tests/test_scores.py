"""Tests for the pure health-score functions (baseline, recovery, TRIMP, strain, data quality)."""

import math
from datetime import date, timedelta

import pytest

from yawmi.domain.scores import (
    Baseline,
    baseline,
    data_quality,
    recovery,
    strain,
    trimp,
    zscore,
)

# --- baseline -------------------------------------------------------------------------------
#
# D-065: the window is the 28 calendar days [day - 28, day - 1]; no baseline below 7 valid nights;
# "full" only when each 7-day block of the window holds at least 4 valid nights; otherwise
# "provisional". Mean and SD are over every valid value in the window.

DAY = date(2026, 11, 10)


def dated(values, *, day=DAY):
    """`values` on consecutive nights ending the day before `day` (the last value is day - 1)."""
    n = len(values)
    return [(day - timedelta(days=n - i), v) for i, v in enumerate(values)]


def on(offsets, value=60.0):
    """One night `value` at each `day - offset`."""
    return [(DAY - timedelta(days=o), value) for o in offsets]


# 4 nights in each block: [28..22], [21..15], [14..8], [7..1] (offsets before DAY)
SIXTEEN = [28, 26, 24, 22, 21, 19, 17, 15, 14, 12, 10, 8, 7, 5, 3, 1]


def test_baseline_none_below_seven_nights():
    assert baseline(dated([1] * 6), DAY) is None
    assert baseline([], DAY) is None


def test_seven_nights_in_one_week_are_provisional():
    b = baseline(dated([60] * 7), DAY)
    assert b is not None
    assert (b.quality, b.n) == ("provisional", 7)


def test_sixteen_nights_four_per_week_are_full():
    b = baseline(on(SIXTEEN), DAY)
    assert b is not None
    assert (b.quality, b.n) == ("full", 16)


def test_one_week_at_three_nights_is_provisional():
    """The most a window can hold with one block at 3 is 24 nights (27 cannot leave a week at 3)."""
    three = [o for o in range(1, 29) if o not in (8, 9, 10, 11)]  # block [14..8] keeps 14, 13, 12
    assert len(three) == 24
    assert baseline(on(three), DAY).quality == "provisional"
    four = [o for o in range(1, 29) if o not in (9, 10, 11)]  # block [14..8] keeps 14, 13, 12, 8
    assert baseline(on(four), DAY).quality == "full"


def test_twenty_seven_of_twenty_eight_nights_are_full():
    assert baseline(on([o for o in range(1, 29) if o != 4]), DAY).quality == "full"


def test_twenty_eight_consecutive_nights_are_full():
    assert baseline(dated([60] * 28), DAY).quality == "full"


BOUNDARY_22 = [28, 27, 26, 22, 20, 18, 17, 16, 14, 12, 10, 9, 6, 5, 3, 2]
BOUNDARY_8 = [28, 27, 26, 25, 20, 19, 18, 17, 13, 12, 11, 8, 6, 5, 3, 2]


@pytest.mark.parametrize(
    ("nights", "edge", "next_day"),
    [(BOUNDARY_22, 22, 21), (BOUNDARY_8, 8, 7)],
    ids=["day-22|day-21", "day-8|day-7"],
)
def test_block_boundaries(nights, edge, next_day):
    """day - 22 is the last night of the first block, day - 21 the first of the second; the same
    for day - 8 / day - 7. Moving the edge night one day later leaves its block at 3 nights."""
    assert baseline(on(nights), DAY).quality == "full"
    moved = [next_day if o == edge else o for o in nights]
    assert baseline(on(moved), DAY).quality == "provisional"


def test_nights_outside_the_window_are_ignored():
    outside = on([29, 30, 31, 40], 1000.0) + on([0, -1], 1000.0)
    b = baseline(on(SIXTEEN) + outside, DAY)
    assert b is not None
    assert (b.n, b.mean, b.quality) == (16, pytest.approx(60.0), "full")
    assert baseline(on(range(29, 60)), DAY) is None


def test_baseline_mean_sd_n():
    b = baseline(dated([50, 60, 70, 50, 60, 70, 60]), DAY)
    assert isinstance(b, Baseline)
    assert b.n == 7
    assert b.mean == pytest.approx(60.0)
    # Sample standard deviation (n - 1): sqrt(400 / 6).
    assert b.sd == pytest.approx(math.sqrt(400 / 6))


def test_baseline_log_computes_on_ln_scale():
    values = [40.0, 50.0, 60.0, 45.0, 55.0, 65.0, 50.0]
    b = baseline(dated(values), DAY, log=True)
    logs = [math.log(x) for x in values]
    assert b is not None
    assert b.mean == pytest.approx(sum(logs) / 7)


def test_baseline_log_rejects_non_positive_values():
    with pytest.raises(ValueError, match="strictly positive"):
        baseline(dated([50.0] * 6 + [0.0]), DAY, log=True)
    with pytest.raises(ValueError, match="strictly positive"):
        baseline(dated([50.0] * 6 + [-3.0]), DAY, log=True)


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_baseline_rejects_non_finite_values(bad):
    with pytest.raises(ValueError, match="finite"):
        baseline(dated([50.0] * 6 + [bad]), DAY)
    with pytest.raises(ValueError, match="finite"):
        baseline(dated([50.0] * 6 + [bad]), DAY, log=True)


def test_baseline_is_frozen():
    b = baseline(dated([60] * 10), DAY)
    with pytest.raises(AttributeError):
        b.mean = 1.0  # type: ignore[misc]


# --- zscore ---------------------------------------------------------------------------------


def test_zscore_plain():
    b = Baseline(mean=60.0, sd=5.0, n=28, quality="full")
    assert zscore(70.0, b) == pytest.approx(2.0)
    assert zscore(55.0, b) == pytest.approx(-1.0)


def test_zscore_zero_sd_gives_zero():
    b = Baseline(mean=60.0, sd=0.0, n=28, quality="full")
    assert zscore(99.0, b) == 0.0
    assert zscore(99.0, b, log=True) == 0.0


def test_zscore_log_uses_ln_of_value():
    b = Baseline(mean=math.log(50.0), sd=0.2, n=28, quality="full")
    assert zscore(50.0, b, log=True) == pytest.approx(0.0)
    assert zscore(50.0 * math.exp(0.2), b, log=True) == pytest.approx(1.0)


@pytest.mark.parametrize("bad", [0.0, -1.0])
def test_zscore_log_rejects_non_positive_value(bad):
    b = Baseline(mean=math.log(50.0), sd=0.2, n=28, quality="full")
    with pytest.raises(ValueError, match="strictly positive"):
        zscore(bad, b, log=True)


def test_zscore_log_rejects_non_positive_value_even_when_sd_is_zero():
    b = Baseline(mean=math.log(50.0), sd=0.0, n=28, quality="full")
    with pytest.raises(ValueError, match="strictly positive"):
        zscore(0.0, b, log=True)


def test_zscore_non_log_accepts_zero_and_negative_values():
    b = Baseline(mean=60.0, sd=5.0, n=28, quality="full")
    assert zscore(0.0, b) == pytest.approx(-12.0)
    assert zscore(-5.0, b) == pytest.approx(-13.0)


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_zscore_rejects_non_finite_value(bad):
    b = Baseline(mean=60.0, sd=5.0, n=28, quality="full")
    with pytest.raises(ValueError, match="finite"):
        zscore(bad, b)
    with pytest.raises(ValueError, match="finite"):
        zscore(bad, b, log=True)


# --- recovery -------------------------------------------------------------------------------


def test_recovery_neutral_is_50():
    assert recovery(0, 0, 0) == 50


def test_recovery_one_sd_hrv_is_69():
    assert recovery(1, 0, 0) == 69


def test_recovery_clips_at_zero_and_hundred():
    assert recovery(-5, -5, -5) == 0
    assert recovery(5, 5, 5) == 100


def test_recovery_returns_int():
    assert isinstance(recovery(0.3, -0.2, 0.1), int)


def test_recovery_penalty_is_subtracted_before_clipping():
    assert recovery(0, 0, 0, penalty=10.0) == 40
    assert recovery(5, 5, 5, penalty=10.0) == 90
    assert recovery(-5, -5, -5, penalty=10.0) == 0


def test_recovery_rounds_half_up_not_bankers():
    # Neutral z gives exactly 50.0; the penalty creates exact .5 ties.
    # Python's round() would give 50 / 48 / 48; half-up gives 50 / 49 / 48.
    assert recovery(0, 0, 0, penalty=0.5) == 50
    assert recovery(0, 0, 0, penalty=1.5) == 49
    assert recovery(0, 0, 0, penalty=2.5) == 48


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_recovery_rejects_non_finite_inputs(bad):
    with pytest.raises(ValueError, match="finite"):
        recovery(bad, 0, 0)
    with pytest.raises(ValueError, match="finite"):
        recovery(0, bad, 0)
    with pytest.raises(ValueError, match="finite"):
        recovery(0, 0, bad)
    with pytest.raises(ValueError, match="finite"):
        recovery(0, 0, 0, penalty=bad)


def test_recovery_weights():
    # Φ(0.5·2) = Φ(1.0) ≈ 0.8413 -> 84; Φ(0.3·2) = Φ(0.6) ≈ 0.7257 -> 73; Φ(0.2·2) = Φ(0.4).
    assert recovery(2, 0, 0) == 84
    assert recovery(0, 2, 0) == 73
    assert recovery(0, 0, 2) == 66


# --- trimp ----------------------------------------------------------------------------------


def test_trimp_male_reference_value():
    assert abs(trimp(10, 0.5) - 8.357) < 0.01


def test_trimp_female_constants():
    expected = 10 * 0.5 * 0.86 * math.exp(1.67 * 0.5)
    assert trimp(10, 0.5, female=True) == pytest.approx(expected)
    assert trimp(10, 0.5, female=True) != pytest.approx(trimp(10, 0.5))


def test_trimp_zero_for_no_time_or_no_reserve():
    assert trimp(0, 0.5) == 0.0
    assert trimp(10, 0.0) == 0.0


def test_trimp_clamps_inputs():
    assert trimp(-5, 0.5) == 0.0
    assert trimp(10, 1.5) == pytest.approx(trimp(10, 1.0))
    assert trimp(10, -0.2) == 0.0


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_trimp_rejects_non_finite_inputs(bad):
    with pytest.raises(ValueError, match="finite"):
        trimp(bad, 0.5)
    with pytest.raises(ValueError, match="finite"):
        trimp(10, bad)


# --- strain ---------------------------------------------------------------------------------


def test_strain_zero():
    assert strain(0) == 0


def test_strain_saturates_at_21():
    assert strain(1e6) == pytest.approx(21)
    assert strain(1e6) <= 21


def test_strain_is_monotonic():
    assert strain(120) < strain(240)


def test_strain_reference_value():
    assert strain(120) == pytest.approx(21 * (1 - math.exp(-1)))


def test_strain_negative_input_is_zero():
    assert strain(-50) == 0


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_strain_rejects_non_finite_input(bad):
    with pytest.raises(ValueError, match="finite"):
        strain(bad)


# --- data_quality ---------------------------------------------------------------------------


def test_data_quality_missing_without_watch_night():
    assert data_quality(False, 0) == "missing"
    assert data_quality(False, 10) == "missing"


def test_data_quality_low_under_three_samples():
    assert data_quality(True, 0) == "low"
    assert data_quality(True, 2) == "low"


def test_data_quality_ok_from_three_samples():
    assert data_quality(True, 3) == "ok"
    assert data_quality(True, 12) == "ok"
