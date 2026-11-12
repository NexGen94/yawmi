"""Indicators store protocol and Postgres implementation."""

from datetime import datetime
from decimal import Decimal
from typing import Protocol
from uuid import UUID, uuid4

import asyncpg

from yawmi.indicators.models import IndicatorIn, IndicatorIO, IndicatorReminderIO

LIST_INDICATORS = """
SELECT id, subject_kind, subject_ref, title_ar, source, measure, target, period, display, reminder_time, reminder_mask, updated_at
FROM yawmi.indicators
ORDER BY updated_at ASC
"""

GET_INDICATOR = """
SELECT id, subject_kind, subject_ref, title_ar, source, measure, target, period, display, reminder_time, reminder_mask, updated_at
FROM yawmi.indicators
WHERE subject_kind = $1 AND subject_ref = $2
"""

UPSERT_INDICATOR = """
INSERT INTO yawmi.indicators (
    id, subject_kind, subject_ref, title_ar, source, measure, target, period, display, reminder_time, reminder_mask, updated_at
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
RETURNING id, subject_kind, subject_ref, title_ar, source, measure, target, period, display, reminder_time, reminder_mask, updated_at
"""

DELETE_INDICATOR = """
DELETE FROM yawmi.indicators
WHERE subject_kind = $1 AND subject_ref = $2
"""


def row_to_indicator(r: asyncpg.Record) -> IndicatorIO:
    rem_time = r["reminder_time"]
    rem_mask = r["reminder_mask"]
    reminder = None
    if rem_time is not None and rem_mask is not None:
        time_str = (
            rem_time.strftime("%H:%M") if hasattr(rem_time, "strftime") else str(rem_time)[:5]
        )
        reminder = IndicatorReminderIO(time=time_str, days_mask=rem_mask)
    target = float(r["target"]) if r["target"] is not None else None
    return IndicatorIO(
        id=r["id"],
        subject_kind=r["subject_kind"],
        subject_ref=r["subject_ref"],
        title_ar=r["title_ar"],
        source=r["source"],
        measure=r["measure"],
        target=target,
        period=r["period"],
        display=r["display"],
        reminder=reminder,
        updated_at=r["updated_at"],
    )


class IndicatorStore(Protocol):
    async def list_all(self) -> list[IndicatorIO]: ...
    async def get(self, subject_kind: str, subject_ref: str) -> IndicatorIO | None: ...
    async def put(self, item: IndicatorIn, *, id: UUID | None = None) -> IndicatorIO: ...
    async def delete(self, subject_kind: str, subject_ref: str) -> bool: ...


class AsyncpgIndicatorStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list_all(self) -> list[IndicatorIO]:
        rows = await self._pool.fetch(LIST_INDICATORS)
        return [row_to_indicator(r) for r in rows]

    async def get(self, subject_kind: str, subject_ref: str) -> IndicatorIO | None:
        row = await self._pool.fetchrow(GET_INDICATOR, subject_kind, subject_ref)
        return row_to_indicator(row) if row is not None else None

    async def put(self, item: IndicatorIn, *, id: UUID | None = None) -> IndicatorIO:
        ind_id = id or uuid4()
        rem_time = None
        rem_mask = None
        if item.reminder is not None:
            rem_time = datetime.strptime(item.reminder.time, "%H:%M").time()
            rem_mask = item.reminder.days_mask
        target = Decimal(str(item.target)) if item.target is not None else None
        row = await self._pool.fetchrow(
            UPSERT_INDICATOR,
            ind_id,
            item.subject_kind,
            item.subject_ref,
            item.title_ar,
            item.source,
            item.measure,
            target,
            item.period,
            item.display,
            rem_time,
            rem_mask,
        )
        assert row is not None
        return row_to_indicator(row)

    async def delete(self, subject_kind: str, subject_ref: str) -> bool:
        res = await self._pool.execute(DELETE_INDICATOR, subject_kind, subject_ref)
        return res != "DELETE 0"
