"""Tests for the pure health-score functions (baseline, recovery, TRIMP, strain, data quality)."""

import math

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


def test_baseline_none_below_seven_nights():
    assert baseline([1] * 6) is None
    assert baseline([]) is None


def test_baseline_provisional_from_seven_until_fourteen():
    assert baseline([60] * 7).quality == "provisional"
    assert baseline([60] * 10).quality == "provisional"
    assert baseline([60] * 13).quality == "provisional"


def test_baseline_full_from_fourteen():
    assert baseline([60] * 14).quality == "full"
    assert baseline([60] * 28).quality == "full"


def test_baseline_mean_sd_n():
    b = baseline([50, 60, 70, 50, 60, 70, 60])
    assert isinstance(b, Baseline)
    assert b.n == 7
    assert b.mean == pytest.approx(60.0)
    # Sample standard deviation (n - 1): sqrt(400 / 6).
    assert b.sd == pytest.approx(math.sqrt(400 / 6))


def test_baseline_uses_only_the_last_28_values():
    values = [1000.0] * 10 + [60.0] * 28
    b = baseline(values)
    assert b is not None
    assert b.n == 28
    assert b.mean == pytest.approx(60.0)
    assert b.sd == pytest.approx(0.0)


def test_baseline_log_computes_on_ln_scale():
    b = baseline([40.0, 50.0, 60.0, 45.0, 55.0, 65.0, 50.0], log=True)
    logs = [math.log(x) for x in (40.0, 50.0, 60.0, 45.0, 55.0, 65.0, 50.0)]
    assert b is not None
    assert b.mean == pytest.approx(sum(logs) / 7)


def test_baseline_log_rejects_non_positive_values():
    with pytest.raises(ValueError):
        baseline([50.0] * 6 + [0.0], log=True)


def test_baseline_is_frozen():
    b = baseline([60] * 10)
    with pytest.raises(AttributeError):
        b.mean = 1.0  # type: ignore[misc]


# --- zscore ---------------------------------------------------------------------------------


def test_zscore_plain():
    b = Baseline(mean=60.0, sd=5.0, n=14, quality="full")
    assert zscore(70.0, b) == pytest.approx(2.0)
    assert zscore(55.0, b) == pytest.approx(-1.0)


def test_zscore_zero_sd_gives_zero():
    b = Baseline(mean=60.0, sd=0.0, n=14, quality="full")
    assert zscore(99.0, b) == 0.0
    assert zscore(99.0, b, log=True) == 0.0


def test_zscore_log_uses_ln_of_value():
    b = Baseline(mean=math.log(50.0), sd=0.2, n=14, quality="full")
    assert zscore(50.0, b, log=True) == pytest.approx(0.0)
    assert zscore(50.0 * math.exp(0.2), b, log=True) == pytest.approx(1.0)


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
