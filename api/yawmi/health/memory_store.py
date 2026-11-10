"""In-memory `HealthStore`: for tests and local experiments, never for production."""

from datetime import date

from yawmi.health.compute import Night
from yawmi.health.store import DailyRow


class InMemoryHealthStore:
    def __init__(self) -> None:
        self.rows: dict[date, DailyRow] = {}

    async def nights(self, first: date, last: date) -> list[Night]:
        return [
            Night(
                day=row.day,
                hrv_ms=None if row.hrv_ms is None else float(row.hrv_ms),
                rhr_bpm=None if row.rhr_bpm is None else float(row.rhr_bpm),
                sleep_minutes=row.sleep_minutes,
                data_quality=row.data_quality,
            )
            for day, row in sorted(self.rows.items())
            if first <= day <= last
        ]

    async def save(self, row: DailyRow) -> None:
        self.rows[row.day] = row
