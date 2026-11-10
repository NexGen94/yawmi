"""Scores for one day from its raw metrics and the nights before it. Pure: no I/O, no clock.

The formulas and constants are in `yawmi.domain.scores`; this module only decides which values
go in:

* **Valid nights.** Only nights whose stored `data_quality` is `ok` feed a baseline, and only
  inside the 28 days before the scored day (`[day − 28, day − 1]`). A night without the watch
  (`missing`) or with too few HRV samples (`low`) is never counted, and an empty value is
  skipped, never read as zero. Each metric gets its own baseline over its own valid values:
  none below 7 nights, `full` when each 7-day block of the window holds 4 of them, else
  `provisional` (D-065, in `yawmi.domain.scores.baseline_quality`).
* **Resting heart rate.** A lower RHR is better, so its z-score is negated before it reaches
  `recovery` (which weighs every z with a plus sign).
* **Recovery** needs today's HRV, RHR and sleep, a night that is not `missing`, and all three
  baselines (at least 7 valid nights each); otherwise it is `None`, never a guess.
* **Strain** is the saturating curve of the day's summed TRIMP, rounded half-up to one decimal
  (the column is `numeric(4, 1)`); `None` when no exertion was sent.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from yawmi.domain.scores import (
    Baseline,
    BaselineQuality,
    DataQuality,
    baseline,
    baseline_window,
    data_quality,
    recovery,
    strain,
    trimp,
    zscore,
)

TrimpCoefficients = Literal["male", "female"]


@dataclass(frozen=True)
class Night:
    """A stored day, with the columns the baselines read."""

    day: date
    hrv_ms: float | None
    rhr_bpm: float | None
    sleep_minutes: int | None
    data_quality: DataQuality


@dataclass(frozen=True)
class Segment:
    """One stretch of exertion: its length and the heart-rate reserve held (0..1)."""

    minutes: float
    hr_reserve: float


@dataclass(frozen=True)
class BaselineSummary:
    quality: BaselineQuality
    nights: int  # the fewest valid nights behind any of the three baselines


@dataclass(frozen=True)
class DayScores:
    recovery_score: int | None
    strain_score: Decimal | None
    data_quality: DataQuality
    baseline: BaselineSummary | None


def window(day: date) -> tuple[date, date]:
    """The baseline window of `day`: the 28 days before it, both ends included."""
    return baseline_window(day)


def valid_values(nights: Iterable[Night], field: str) -> list[tuple[date, float]]:
    """`(day, field)` of the valid nights (`ok`, value present), oldest first.

    The window and the per-week quality are applied by `yawmi.domain.scores.baseline`.
    """
    picked = sorted((n for n in nights if n.data_quality == "ok"), key=lambda n: n.day)
    return [(n.day, float(v)) for n in picked if (v := getattr(n, field)) is not None]


def round_strain(value: float) -> Decimal:
    """Half-up to one decimal, like the TypeScript and Swift ports (never banker's rounding)."""
    return Decimal(repr(value)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


def summarise(baselines: Sequence[Baseline | None]) -> BaselineSummary | None:
    """`None` until every baseline exists; `provisional` while any of them is."""
    present = [b for b in baselines if b is not None]
    if len(present) < len(baselines):
        return None
    quality: BaselineQuality = (
        "full" if all(b.quality == "full" for b in present) else "provisional"
    )
    return BaselineSummary(quality=quality, nights=min(b.n for b in present))


def score_day(
    *,
    day: date,
    hrv_ms: float | None,
    rhr_bpm: float | None,
    sleep_minutes: int | None,
    has_watch_night: bool,
    hrv_samples: int,
    history: Iterable[Night],
    exertion: Sequence[Segment] = (),
    coefficients: TrimpCoefficients | None = None,
) -> DayScores:
    """Recovery, strain, data quality and baseline status of `day` (see the module docstring)."""
    nights = list(history)
    quality = data_quality(has_watch_night, hrv_samples)
    # HRV is averaged on ln(x), so a zero reading cannot enter its baseline
    hrv_base = baseline([(d, v) for d, v in valid_values(nights, "hrv_ms") if v > 0], day, log=True)
    rhr_base = baseline(valid_values(nights, "rhr_bpm"), day)
    sleep_base = baseline(valid_values(nights, "sleep_minutes"), day)
    summary = summarise([hrv_base, rhr_base, sleep_base])

    score: int | None = None
    if (
        quality != "missing"
        and hrv_base is not None
        and rhr_base is not None
        and sleep_base is not None
        and hrv_ms is not None
        and hrv_ms > 0
        and rhr_bpm is not None
        and sleep_minutes is not None
    ):
        z_hrv = zscore(hrv_ms, hrv_base, log=True)
        z_rhr = -zscore(rhr_bpm, rhr_base)  # lower resting heart rate is better
        z_sleep = zscore(sleep_minutes, sleep_base)
        score = recovery(z_hrv, z_rhr, z_sleep)

    strain_score: Decimal | None = None
    if exertion:
        female = coefficients == "female"
        total = sum(trimp(s.minutes, s.hr_reserve, female=female) for s in exertion)
        strain_score = round_strain(strain(total))

    return DayScores(
        recovery_score=score, strain_score=strain_score, data_quality=quality, baseline=summary
    )
