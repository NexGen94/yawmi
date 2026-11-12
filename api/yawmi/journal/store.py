"""Postgres reader for `GET /v1/journal` and `GET /v1/mood`."""

import json
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal, Protocol

import asyncpg

_SELECT_JOURNAL_ENTRIES = """
SELECT day, part, answers, logged_at
FROM yawmi.journal_entries
WHERE day BETWEEN $1 AND $2
ORDER BY day, part
"""

_SELECT_MOOD_LOGS = """
SELECT day, score, feelings, activities
FROM yawmi.mood_logs
WHERE day BETWEEN $1 AND $2
ORDER BY day
"""


@dataclass(frozen=True)
class JournalRow:
    day: date
    part: Literal["morning", "evening"]
    answers: dict[str, Any]
    logged_at: datetime


@dataclass(frozen=True)
class MoodRow:
    day: date
    score: int
    feelings: list[str]
    activities: list[str]


class JournalReader(Protocol):
    async def entries(self, first: date, last: date) -> list[JournalRow]: ...

    async def moods(self, first: date, last: date) -> list[MoodRow]: ...


def _json_obj(raw: object) -> dict[str, Any]:
    val = json.loads(raw) if isinstance(raw, str) else raw
    return dict(val) if isinstance(val, dict) else {}


def _json_str_list(raw: object) -> list[str]:
    val = json.loads(raw) if isinstance(raw, str) else raw
    return [str(x) for x in val] if isinstance(val, list) else []


class AsyncpgJournalReader:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def entries(self, first: date, last: date) -> list[JournalRow]:
        rows = await self._pool.fetch(_SELECT_JOURNAL_ENTRIES, first, last)
        return [
            JournalRow(
                day=r["day"],
                part=r["part"],
                answers=_json_obj(r["answers"]),
                logged_at=r["logged_at"],
            )
            for r in rows
        ]

    async def moods(self, first: date, last: date) -> list[MoodRow]:
        rows = await self._pool.fetch(_SELECT_MOOD_LOGS, first, last)
        return [
            MoodRow(
                day=r["day"],
                score=int(r["score"]),
                feelings=_json_str_list(r["feelings"]),
                activities=_json_str_list(r["activities"]),
            )
            for r in rows
        ]
