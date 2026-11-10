"""`daily_metrics` persistence: the `HealthStore` contract and its Postgres implementation.

One row per local day (one user, so no user id). `save` is an upsert on `day`: the device
recomputes the last 48 hours on every unlock (spec § 2.4) and resends, so the newest upload of
a day replaces the older one, scores included.
"""

from dataclasses import dataclass, fields
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol

import asyncpg

from yawmi.domain.scores import DataQuality
from yawmi.health.compute import Night


@dataclass(frozen=True)
class DailyRow:
    """A full `yawmi.daily_metrics` row as written (field names are the column names)."""

    day: date
    hrv_ms: Decimal | None = None
    hrv_rmssd_ms: Decimal | None = None
    rhr_bpm: Decimal | None = None
    sleeping_hr_bpm: Decimal | None = None
    walking_hr_bpm: Decimal | None = None
    resp_rate_bpm: Decimal | None = None
    wrist_temp_delta_c: Decimal | None = None
    spo2_pct: Decimal | None = None
    sleep_minutes: int | None = None
    sleep_core_minutes: int | None = None
    sleep_deep_minutes: int | None = None
    sleep_rem_minutes: int | None = None
    sleep_awake_minutes: int | None = None
    in_bed_minutes: int | None = None
    sleep_start: datetime | None = None
    sleep_end: datetime | None = None
    steps: int | None = None
    active_kcal: Decimal | None = None
    exercise_minutes: int | None = None
    mindful_minutes: int | None = None
    recovery_score: int | None = None
    strain_score: Decimal | None = None
    data_quality: DataQuality = "missing"


COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(DailyRow))


class HealthStore(Protocol):
    async def nights(self, first: date, last: date) -> list[Night]:
        """Stored days in `[first, last]`, any quality (the caller filters), oldest first."""
        ...

    async def save(self, row: DailyRow) -> None:
        """Insert the day, or replace every column of an existing one."""
        ...


_NIGHTS = """
SELECT day, hrv_ms, rhr_bpm, sleep_minutes, data_quality
FROM yawmi.daily_metrics
WHERE day BETWEEN $1 AND $2
ORDER BY day
"""

_UPSERT = (
    f"INSERT INTO yawmi.daily_metrics ({', '.join(COLUMNS)}, computed_at)\n"
    f"VALUES ({', '.join(f'${i}' for i in range(1, len(COLUMNS) + 1))}, now())\n"
    "ON CONFLICT (day) DO UPDATE SET "
    + ", ".join(f"{c} = excluded.{c}" for c in COLUMNS if c != "day")
    + ", computed_at = excluded.computed_at"
)


def night_from_row(row: "asyncpg.Record | dict[str, object]") -> Night:
    hrv, rhr = row["hrv_ms"], row["rhr_bpm"]
    return Night(
        day=row["day"],  # type: ignore[arg-type]
        hrv_ms=None if hrv is None else float(hrv),  # type: ignore[arg-type]
        rhr_bpm=None if rhr is None else float(rhr),  # type: ignore[arg-type]
        sleep_minutes=row["sleep_minutes"],  # type: ignore[arg-type]
        data_quality=row["data_quality"],  # type: ignore[arg-type]
    )


def row_args(row: DailyRow) -> tuple[object, ...]:
    return tuple(getattr(row, c) for c in COLUMNS)


class AsyncpgHealthStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def nights(self, first: date, last: date) -> list[Night]:
        return [night_from_row(r) for r in await self._pool.fetch(_NIGHTS, first, last)]

    async def save(self, row: DailyRow) -> None:
        await self._pool.execute(_UPSERT, *row_args(row))
