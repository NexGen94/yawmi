"""Indicators store protocol and Postgres implementation."""

from datetime import datetime
from decimal import Decimal
from typing import Protocol
from uuid import uuid4

import asyncpg

from yawmi.habits.models import ReminderIO
from yawmi.indicators.models import IndicatorIO

_COLUMNS = (
    "id, subject_kind, subject_ref, title_ar, source, measure, target, period, display,"
    " reminder_time, reminder_mask, updated_at"
)

LIST_INDICATORS = f"SELECT {_COLUMNS} FROM yawmi.indicators ORDER BY updated_at ASC"

UPSERT_INDICATOR = f"""
INSERT INTO yawmi.indicators (
    id, subject_kind, subject_ref, title_ar, source, measure, target, period, display,
    reminder_time, reminder_mask, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
ON CONFLICT (subject_kind, subject_ref) DO UPDATE SET
    title_ar = EXCLUDED.title_ar,
    source = EXCLUDED.source,
    measure = EXCLUDED.measure,
    target = EXCLUDED.target,
    period = EXCLUDED.period,
    display = EXCLUDED.display,
    reminder_time = EXCLUDED.reminder_time,
    reminder_mask = EXCLUDED.reminder_mask,
    updated_at = now()
RETURNING {_COLUMNS}
"""

DELETE_INDICATOR = """
DELETE FROM yawmi.indicators
WHERE subject_kind = $1 AND subject_ref = $2
"""


def row_to_indicator(r: asyncpg.Record) -> IndicatorIO:
    reminder = None
    if r["reminder_time"] is not None and r["reminder_mask"] is not None:
        reminder = ReminderIO(
            time=r["reminder_time"].strftime("%H:%M"), days_mask=r["reminder_mask"]
        )
    return IndicatorIO(
        id=r["id"],
        subject_kind=r["subject_kind"],
        subject_ref=r["subject_ref"],
        title_ar=r["title_ar"],
        source=r["source"],
        measure=r["measure"],
        target=float(r["target"]) if r["target"] is not None else None,
        period=r["period"],
        display=r["display"],
        reminder=reminder,
        updated_at=r["updated_at"],
    )


class IndicatorStore(Protocol):
    async def list(self) -> list[IndicatorIO]: ...
    async def put(self, item: IndicatorIO) -> IndicatorIO: ...
    async def delete(self, subject_kind: str, subject_ref: str) -> bool: ...


class AsyncpgIndicatorStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list(self) -> list[IndicatorIO]:
        rows = await self._pool.fetch(LIST_INDICATORS)
        return [row_to_indicator(r) for r in rows]

    async def put(self, item: IndicatorIO) -> IndicatorIO:
        """Insert or replace the indicator of its subject; the id and time are the server's."""
        reminder_time = reminder_mask = None
        if item.reminder is not None:
            reminder_time = datetime.strptime(item.reminder.time, "%H:%M").time()
            reminder_mask = item.reminder.days_mask
        row = await self._pool.fetchrow(
            UPSERT_INDICATOR,
            uuid4(),
            item.subject_kind,
            item.subject_ref,
            item.title_ar,
            item.source,
            item.measure,
            Decimal(str(item.target)) if item.target is not None else None,
            item.period,
            item.display,
            reminder_time,
            reminder_mask,
        )
        assert row is not None
        return row_to_indicator(row)

    async def delete(self, subject_kind: str, subject_ref: str) -> bool:
        res = await self._pool.execute(DELETE_INDICATOR, subject_kind, subject_ref)
        return res != "DELETE 0"
