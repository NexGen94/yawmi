"""What `GET /v1/goals` reads from the Notion mirror: row types, the `GoalsReader` contract, Postgres.

Every statement names its columns, and none touches `props` or `note` (personal free text that
`yawmi_api` is not granted). The card's target date and next step are the two named keys of
`props` that the read-only view `yawmi_ro.notion_card_fields` exposes (design §8.4); it is read by
its qualified name, because the role's `search_path` is `yawmi`. The target date comes out of the
view as text: the first ten characters are the date, anything else is `None`.

The reader returns plain rows and decides nothing: completion, overdue days and indicators are
decided in `yawmi.goals.assemble`. An empty mirror gives empty lists and `None`: an empty state,
never an error.
"""

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol

import asyncpg

from yawmi.today.reader import _codes


@dataclass(frozen=True)
class OutcomeRow:
    code: str
    title: str
    track: str
    target_date: date
    acceptance: str
    status: str


@dataclass(frozen=True)
class CycleFullRow:
    cycle_no: int
    stage_no: int
    start_date: date
    end_date: date
    review_start: date
    review_end: date
    theme: str
    gate: str


@dataclass(frozen=True)
class MilestoneFullRow:
    page_id: str
    title: str
    outcome_code: str | None
    card_page_ids: tuple[str, ...]
    cycle_no: int | None
    due_date: date | None
    done: bool
    criterion: str | None
    evidence: str | None
    notion_edited_at: datetime | None


@dataclass(frozen=True)
class CardFullRow:
    page_id: str
    title: str
    status: str | None
    outcome_codes: tuple[str, ...]
    notion_edited_at: datetime | None


@dataclass(frozen=True)
class CardFieldsRow:
    page_id: str
    target_date: date | None
    next_step: str | None


@dataclass(frozen=True)
class KpiRow:
    code: str
    name: str
    unit: str
    direction: str
    target: Decimal | None
    frequency: str
    goal_code: str | None


@dataclass(frozen=True)
class ReadingRow:
    kpi_code: str
    day: date
    value: Decimal


class GoalsReader(Protocol):
    async def outcomes(self) -> list[OutcomeRow]:
        """Every row of `raqib.goals`, by code."""
        ...

    async def cycles(self) -> list[CycleFullRow]: ...

    async def milestones(self) -> list[MilestoneFullRow]: ...

    async def cards(self) -> list[CardFullRow]: ...

    async def card_fields(self) -> list[CardFieldsRow]:
        """The target date and next step of every card, through the read-only view."""
        ...

    async def kpis(self) -> list[KpiRow]: ...

    async def latest_readings(self) -> dict[str, ReadingRow]:
        """The newest reading of each KPI that has one, by KPI code."""
        ...

    async def readings(self, kpi_code: str) -> list[ReadingRow]:
        """All readings of one KPI, oldest first."""
        ...

    async def last_synced(self) -> datetime | None:
        """When the mirror last synced, or `None` while it is empty."""
        ...


def card_target_date(text: object) -> date | None:
    """The date in the first ten characters of the view's `target_date`, else `None`."""
    if not isinstance(text, str):
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


OUTCOMES = """
SELECT code, title, track, target_date, acceptance, status
FROM raqib.goals
ORDER BY code
"""

CYCLES = """
SELECT cycle_no, stage_no, start_date, end_date, review_start, review_end, theme, gate
FROM raqib.cycles
ORDER BY cycle_no
"""

MILESTONES = """
SELECT page_id, title, outcome_code, card_page_ids, cycle_no, due_date, done, criterion,
       evidence, notion_edited_at
FROM raqib.notion_milestones
ORDER BY due_date NULLS LAST, cycle_no NULLS LAST, title, page_id
"""

# column-level grant: never `props`
CARDS = """
SELECT page_id, title, status, outcome_codes, notion_edited_at
FROM raqib.notion_cards
ORDER BY title, page_id
"""

# the one window onto the card's `props`: two named keys (design §8.4)
CARD_FIELDS = """
SELECT page_id, target_date, next_step
FROM yawmi_ro.notion_card_fields
"""

KPIS = """
SELECT code, name, unit, direction, target, frequency, goal_code
FROM raqib.kpis
ORDER BY code
"""

# column-level grant: never the free-text column
LATEST_READINGS = """
SELECT DISTINCT ON (kpi_code) kpi_code, reading_date AS day, value
FROM raqib.kpi_readings
ORDER BY kpi_code, reading_date DESC, created_at DESC, id DESC
"""

READINGS = """
SELECT kpi_code, reading_date AS day, value
FROM raqib.kpi_readings
WHERE kpi_code = $1
ORDER BY reading_date, created_at, id
"""

LAST_SYNCED = """
SELECT greatest(
  (SELECT max(synced_at) FROM raqib.notion_milestones),
  (SELECT max(synced_at) FROM raqib.notion_cards)
)
"""

ALL_SQL = (
    OUTCOMES,
    CYCLES,
    MILESTONES,
    CARDS,
    CARD_FIELDS,
    KPIS,
    LATEST_READINGS,
    READINGS,
    LAST_SYNCED,
)


class AsyncpgGoalsReader:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def outcomes(self) -> list[OutcomeRow]:
        return [OutcomeRow(**dict(r)) for r in await self._pool.fetch(OUTCOMES)]

    async def cycles(self) -> list[CycleFullRow]:
        return [CycleFullRow(**dict(r)) for r in await self._pool.fetch(CYCLES)]

    async def milestones(self) -> list[MilestoneFullRow]:
        rows = await self._pool.fetch(MILESTONES)
        return [
            MilestoneFullRow(**{**dict(r), "card_page_ids": _codes(r["card_page_ids"])})
            for r in rows
        ]

    async def cards(self) -> list[CardFullRow]:
        rows = await self._pool.fetch(CARDS)
        return [
            CardFullRow(**{**dict(r), "outcome_codes": _codes(r["outcome_codes"])}) for r in rows
        ]

    async def card_fields(self) -> list[CardFieldsRow]:
        return [
            CardFieldsRow(r["page_id"], card_target_date(r["target_date"]), r["next_step"])
            for r in await self._pool.fetch(CARD_FIELDS)
        ]

    async def kpis(self) -> list[KpiRow]:
        return [KpiRow(**dict(r)) for r in await self._pool.fetch(KPIS)]

    async def latest_readings(self) -> dict[str, ReadingRow]:
        return {
            r["kpi_code"]: ReadingRow(**dict(r)) for r in await self._pool.fetch(LATEST_READINGS)
        }

    async def readings(self, kpi_code: str) -> list[ReadingRow]:
        return [ReadingRow(**dict(r)) for r in await self._pool.fetch(READINGS, kpi_code)]

    async def last_synced(self) -> datetime | None:
        return await self._pool.fetchval(LAST_SYNCED)
