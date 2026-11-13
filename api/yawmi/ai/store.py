"""Persistence of generated insights (`yawmi.ai_insights`).

`InsightStore` is the seam: Postgres in production, `InMemoryInsightStore` in tests. Only the
validated `InsightResponse` fields are stored, with the request hash and the cited source cards
(`cards`, migration 0003), never a request body. `days` is never stored: it is derived from the
cards on every read (R-6). `save_first` is first-writer-wins per kind and day, so a repeated or
concurrent day close keeps one row; `replace` renews a row in place (regeneration with changed
sources, design §10).
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Protocol
from uuid import UUID, uuid4

import asyncpg

from yawmi.ai.cards import InsightOut, SourceCard, days_of
from yawmi.ai.schema import InsightKind, InsightResponse

CLOSURE_KIND = "evening"
# two-key advisory lock (the keys spell "YWMI" and 2): serialises first-writer-wins per store
CLOSURE_LOCK_KEYS = (0x59574D49, 2)


@dataclass(frozen=True)
class StoredInsight:
    id: UUID
    kind: str
    day: date
    provider: str
    model: str
    request_hash: str
    response: InsightResponse
    created_at: datetime
    cards: list[SourceCard] = field(default_factory=list)


def new_insight(
    kind: InsightKind,
    day: date,
    provider: str,
    model: str,
    request_hash: str,
    response: InsightResponse,
    cards: Sequence[SourceCard] = (),
) -> StoredInsight:
    return StoredInsight(
        uuid4(), kind, day, provider, model, request_hash, response, _now(), list(cards)
    )


def _now() -> datetime:
    return datetime.now(UTC)


def insight_out(row: StoredInsight) -> InsightOut:
    """A stored row as the API returns it: `days` derived from the cards, never stored (R-6)."""
    return InsightOut(
        **row.response.model_dump(),
        cards=row.cards,
        days=days_of(row.cards),
        id=row.id,
        kind=row.kind,
        day=row.day,
        created_at=row.created_at,
    )


class InsightStore(Protocol):
    async def get_for_day(self, kind: str, day: date) -> StoredInsight | None:
        """The first stored insight of `kind` for `day`, if any."""
        ...

    async def save_first(self, insight: StoredInsight) -> StoredInsight:
        """Store `insight` unless its kind and day have one; return the one that is stored."""
        ...

    async def replace(self, row_id: UUID, insight: StoredInsight) -> StoredInsight:
        """Renew the row `row_id` in place with `insight`'s content (the id stays)."""
        ...

    async def list_reviews(self, kind: str, limit: int, before: date | None) -> list[StoredInsight]:
        """Newest day first (then newest creation), days strictly before `before` if given."""
        ...


class InMemoryInsightStore:
    def __init__(self) -> None:
        self.rows: list[StoredInsight] = []

    async def get_for_day(self, kind: str, day: date) -> StoredInsight | None:
        found = [r for r in self.rows if r.kind == kind and r.day == day]
        return min(found, key=lambda r: r.created_at) if found else None

    async def get_closure(self, day: date) -> StoredInsight | None:
        return await self.get_for_day(CLOSURE_KIND, day)

    async def save_first(self, insight: StoredInsight) -> StoredInsight:
        existing = await self.get_for_day(insight.kind, insight.day)
        if existing is not None:
            return existing
        self.rows.append(insight)
        return insight

    async def save_closure(self, insight: StoredInsight) -> StoredInsight:
        return await self.save_first(insight)

    async def replace(self, row_id: UUID, insight: StoredInsight) -> StoredInsight:
        for i, row in enumerate(self.rows):
            if row.id == row_id:
                self.rows[i] = StoredInsight(
                    row_id,
                    row.kind,
                    row.day,
                    insight.provider,
                    insight.model,
                    insight.request_hash,
                    insight.response,
                    insight.created_at,
                    list(insight.cards),
                )
                return self.rows[i]
        raise LookupError(row_id)

    async def list_reviews(self, kind: str, limit: int, before: date | None) -> list[StoredInsight]:
        rows = [r for r in self.rows if r.kind == kind and (before is None or r.day < before)]
        rows.sort(key=lambda r: (r.day, r.created_at), reverse=True)
        return rows[:limit]


_COLUMNS = (
    "id, kind, day, provider, model, request_hash, lines, question, source_ids, priorities,"
    " cards, created_at"
)

# Every statement is a named constant, so the grant-coverage test can plan each one as yawmi_api.
_LOCK = "SELECT pg_advisory_xact_lock($1, $2)"
_GET_CLOSURE = (
    f"SELECT {_COLUMNS} FROM yawmi.ai_insights WHERE kind = $1 AND day = $2"
    " ORDER BY created_at, id LIMIT 1"
)
_INSERT_INSIGHT = (
    "INSERT INTO yawmi.ai_insights (id, kind, day, provider, model, request_hash, lines,"
    " question, source_ids, priorities, cards)"
    " VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb)"
    f" RETURNING {_COLUMNS}"
)
_REPLACE_INSIGHT = (
    "UPDATE yawmi.ai_insights SET provider = $2, model = $3, request_hash = $4, lines = $5::jsonb,"
    " question = $6, source_ids = $7::jsonb, priorities = $8::jsonb, cards = $9::jsonb,"
    f" created_at = now() WHERE id = $1 RETURNING {_COLUMNS}"
)
_LIST_REVIEWS = (
    f"SELECT {_COLUMNS} FROM yawmi.ai_insights WHERE kind = $1"
    " AND ($2::date IS NULL OR day < $2) ORDER BY day DESC, created_at DESC, id LIMIT $3"
)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _content(insight: StoredInsight) -> tuple[str, str | None, str, str, str]:
    """The reply columns and the cards as JSON, in the order of the SQL above."""
    r = insight.response
    return (
        _json(r.lines),
        r.question,
        _json(r.source_ids),
        _json([p.model_dump() for p in r.priorities]),
        _json([c.model_dump(mode="json") for c in insight.cards]),
    )


def _from_record(row: asyncpg.Record) -> StoredInsight:
    response = InsightResponse.model_validate(
        {
            "lines": json.loads(row["lines"]),
            "question": row["question"],
            "source_ids": json.loads(row["source_ids"]),
            "priorities": json.loads(row["priorities"]),
        }
    )
    cards = [SourceCard.model_validate(c) for c in json.loads(row["cards"])]
    return StoredInsight(
        row["id"],
        row["kind"],
        row["day"],
        row["provider"],
        row["model"],
        row["request_hash"],
        response,
        row["created_at"],
        cards,
    )


class AsyncpgInsightStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get_for_day(self, kind: str, day: date) -> StoredInsight | None:
        row = await self._pool.fetchrow(_GET_CLOSURE, kind, day)
        return None if row is None else _from_record(row)

    async def get_closure(self, day: date) -> StoredInsight | None:
        return await self.get_for_day(CLOSURE_KIND, day)

    async def save_first(self, insight: StoredInsight) -> StoredInsight:
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(_LOCK, *CLOSURE_LOCK_KEYS)
            row = await conn.fetchrow(_GET_CLOSURE, insight.kind, insight.day)
            if row is not None:
                return _from_record(row)
            lines, question, source_ids, priorities, cards = _content(insight)
            row = await conn.fetchrow(
                _INSERT_INSIGHT,
                insight.id,
                insight.kind,
                insight.day,
                insight.provider,
                insight.model,
                insight.request_hash,
                lines,
                question,
                source_ids,
                priorities,
                cards,
            )
            assert row is not None
            return _from_record(row)

    async def save_closure(self, insight: StoredInsight) -> StoredInsight:
        return await self.save_first(insight)

    async def replace(self, row_id: UUID, insight: StoredInsight) -> StoredInsight:
        row = await self._pool.fetchrow(
            _REPLACE_INSIGHT,
            row_id,
            insight.provider,
            insight.model,
            insight.request_hash,
            *_content(insight),
        )
        if row is None:
            raise LookupError(row_id)
        return _from_record(row)

    async def list_reviews(self, kind: str, limit: int, before: date | None) -> list[StoredInsight]:
        rows = await self._pool.fetch(_LIST_REVIEWS, kind, before, limit)
        return [_from_record(r) for r in rows]
