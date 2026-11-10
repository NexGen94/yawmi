"""Persistence of generated insights (`yawmi.ai_insights`).

`InsightStore` is the seam: Postgres in production, `InMemoryInsightStore` in tests. Only the
validated `InsightResponse` fields are stored, with the request hash, never a request body.
`save_closure` is first-writer-wins per day, so a repeated or concurrent day close keeps one row.
"""

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Protocol
from uuid import UUID, uuid4

import asyncpg

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


def new_insight(
    kind: InsightKind,
    day: date,
    provider: str,
    model: str,
    request_hash: str,
    response: InsightResponse,
) -> StoredInsight:
    return StoredInsight(uuid4(), kind, day, provider, model, request_hash, response, _now())


def _now() -> datetime:
    return datetime.now(UTC)


class InsightStore(Protocol):
    async def get_closure(self, day: date) -> StoredInsight | None: ...

    async def save_closure(self, insight: StoredInsight) -> StoredInsight:
        """Store the day's closure unless one exists; return the one that is stored."""
        ...

    async def list_reviews(self, kind: str, limit: int, before: date | None) -> list[StoredInsight]:
        """Newest day first (then newest creation), days strictly before `before` if given."""
        ...


class InMemoryInsightStore:
    def __init__(self) -> None:
        self.rows: list[StoredInsight] = []

    async def get_closure(self, day: date) -> StoredInsight | None:
        found = [r for r in self.rows if r.kind == CLOSURE_KIND and r.day == day]
        return min(found, key=lambda r: r.created_at) if found else None

    async def save_closure(self, insight: StoredInsight) -> StoredInsight:
        existing = await self.get_closure(insight.day)
        if existing is not None:
            return existing
        self.rows.append(insight)
        return insight

    async def list_reviews(self, kind: str, limit: int, before: date | None) -> list[StoredInsight]:
        rows = [r for r in self.rows if r.kind == kind and (before is None or r.day < before)]
        rows.sort(key=lambda r: (r.day, r.created_at), reverse=True)
        return rows[:limit]


_COLUMNS = "id, kind, day, provider, model, request_hash, lines, question, source_ids, priorities, created_at"


def _from_record(row: asyncpg.Record) -> StoredInsight:
    response = InsightResponse.model_validate(
        {
            "lines": json.loads(row["lines"]),
            "question": row["question"],
            "source_ids": json.loads(row["source_ids"]),
            "priorities": json.loads(row["priorities"]),
        }
    )
    return StoredInsight(
        row["id"],
        row["kind"],
        row["day"],
        row["provider"],
        row["model"],
        row["request_hash"],
        response,
        row["created_at"],
    )


class AsyncpgInsightStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get_closure(self, day: date) -> StoredInsight | None:
        row = await self._pool.fetchrow(
            f"SELECT {_COLUMNS} FROM yawmi.ai_insights WHERE kind = $1 AND day = $2"
            " ORDER BY created_at, id LIMIT 1",
            CLOSURE_KIND,
            day,
        )
        return None if row is None else _from_record(row)

    async def save_closure(self, insight: StoredInsight) -> StoredInsight:
        r = insight.response
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1, $2)", *CLOSURE_LOCK_KEYS)
            row = await conn.fetchrow(
                f"SELECT {_COLUMNS} FROM yawmi.ai_insights WHERE kind = $1 AND day = $2"
                " ORDER BY created_at, id LIMIT 1",
                CLOSURE_KIND,
                insight.day,
            )
            if row is not None:
                return _from_record(row)
            row = await conn.fetchrow(
                "INSERT INTO yawmi.ai_insights (id, kind, day, provider, model, request_hash, lines,"
                " question, source_ids, priorities)"
                " VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb)"
                f" RETURNING {_COLUMNS}",
                insight.id,
                insight.kind,
                insight.day,
                insight.provider,
                insight.model,
                insight.request_hash,
                json.dumps(r.lines, ensure_ascii=False),
                r.question,
                json.dumps(r.source_ids, ensure_ascii=False),
                json.dumps([p.model_dump() for p in r.priorities], ensure_ascii=False),
            )
            assert row is not None
            return _from_record(row)

    async def list_reviews(self, kind: str, limit: int, before: date | None) -> list[StoredInsight]:
        rows = await self._pool.fetch(
            f"SELECT {_COLUMNS} FROM yawmi.ai_insights WHERE kind = $1"
            " AND ($2::date IS NULL OR day < $2) ORDER BY day DESC, created_at DESC, id LIMIT $3",
            kind,
            before,
            limit,
        )
        return [_from_record(r) for r in rows]
