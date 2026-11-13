"""One backend for the AI tests: in-memory stores or Postgres rows behind the same calls.

`AiBackend` sits on a `GoalsBackend` (habits, logs, the mirror) and adds what grounding reads
besides: journal entries, moods, focus and breath days, the consents and the stored insights.
The Postgres backend writes real rows and removes what it wrote; the provider is always the
scripted `RecordingProvider` below, never a network call.
"""

import json
from collections.abc import AsyncIterator, Callable
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from goals_harness import GoalsBackend
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.ai.cards import SourceCard
from yawmi.ai.consent import AsyncpgConsentStore, Consent, InMemoryConsentStore
from yawmi.ai.memory import AsyncpgMemoryStore, InMemoryMemoryStore
from yawmi.ai.reader import InMemorySessionReader, SessionDay
from yawmi.ai.schema import InsightResponse
from yawmi.ai.service import InsightService
from yawmi.ai.store import AsyncpgInsightStore, InMemoryInsightStore, StoredInsight, new_insight
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.journal.memory import InMemoryJournalReader
from yawmi.journal.store import MoodRow
from yawmi.main import create_app
from yawmi.prefs.memory import InMemoryPrefsStore
from yawmi.settings import Settings
from yawmi.today.reader import MetricsRow

SECRET = "test-secret-for-unit-tests-only-0123456789"
DEVICE = UUID("00000000-0000-7000-8000-000000000718")
DAY = date(2026, 11, 10)  # "today" in Riyadh under the conftest clock
FIRST_DAY = date(2026, 9, 1)  # the Postgres rows this harness writes fall in [FIRST_DAY, DAY]
SETTING_KEYS = ["mission", "vision", "ai_lines", "ai_tone"]

Reply = dict[str, Any] | Exception | Callable[[dict[str, Any]], dict[str, Any]]


class RecordingProvider:
    """Replies with the next scripted item (the last one repeats) and records every call."""

    def __init__(self, *script: Reply) -> None:
        self.script: list[Reply] = list(script) or [lambda _: empty_reply()]
        self.calls: list[dict[str, Any]] = []

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        payload = json.loads(user.split("\n\n[تصحيح]", 1)[0])
        self.calls.append(
            {"system": system, "user": user, "payload": payload, "schema": schema, "model": model}
        )
        item = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(item, Exception):
            raise item
        return item(payload) if callable(item) else item

    @property
    def payload(self) -> dict[str, Any]:
        return self.calls[-1]["payload"]

    def sources(self) -> dict[str, dict[str, Any]]:
        return {s["id"]: s for s in self.payload["sources"]}

    def memory(self) -> dict[str, dict[str, Any]]:
        """The memory block of the last request (lenses and saved notes), by id."""
        return {m["id"]: m for m in self.payload.get("memory", [])}


def empty_reply(lines: list[str] | None = None) -> dict[str, Any]:
    return {"lines": lines or ["سطر."], "question": None, "source_ids": [], "priorities": []}


def citing(*ids: str, lines: list[str] | None = None) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """A reply that cites `ids` (only those present in the request, in the given order)."""

    def reply(payload: dict[str, Any]) -> dict[str, Any]:
        present = {s["id"] for s in payload["sources"]}
        return {**empty_reply(lines), "source_ids": [i for i in ids if i in present]}

    return reply


def auth(kind: str = "web") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(DEVICE, kind, SECRET, 3600)}"}


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "database_url": "postgresql://yawmi_api@localhost:5432/raqib",
        "jwt_secret": SecretStr(SECRET),
        "anthropic_api_key": "fake-anthropic-key-not-real",
        **overrides,
    }
    return Settings(**values)


class AiBackend:
    def __init__(self, goals: GoalsBackend) -> None:
        self.goals = goals
        self.kind: str = goals.kind  # type: ignore[attr-defined]
        self.provider = RecordingProvider()
        self.pool = getattr(goals, "pool", None)
        self.journal = InMemoryJournalReader()
        self.sessions = InMemorySessionReader()
        self.consents: Any = InMemoryConsentStore()
        self.insights: Any = InMemoryInsightStore()
        self.prefs = InMemoryPrefsStore()
        self.memory: Any = InMemoryMemoryStore()
        if self.pool is not None:
            self.consents = AsyncpgConsentStore(self.pool)
            self.insights = AsyncpgInsightStore(self.pool)
            self.memory = AsyncpgMemoryStore(self.pool)

    def install(self, app: FastAPI) -> None:
        self.goals.install(app)
        app.state.insights = InsightService(self.provider, app.state.settings)
        if self.pool is None:
            app.state.journal = self.journal
            app.state.sessions = self.sessions
            app.state.ai_consent = self.consents
            app.state.insights_store = self.insights
            app.state.prefs = self.prefs
            app.state.ai_memory = self.memory

    async def setup(self) -> None:
        await self.goals.pause_other_habits()
        if self.pool is not None:
            await self.cleanup()
            await self.pool.execute(
                "INSERT INTO yawmi.devices (id, name, kind) VALUES ($1, 'ai tests', 'web')"
                " ON CONFLICT (id) DO NOTHING",
                DEVICE,
            )

    async def cleanup(self) -> None:
        if self.pool is None:
            return
        days = (FIRST_DAY, DAY)
        for table in ("journal_entries", "mood_logs", "focus_sessions", "breath_sessions"):
            await self.pool.execute(f"DELETE FROM yawmi.{table} WHERE day BETWEEN $1 AND $2", *days)
        await self.pool.execute(
            "DELETE FROM yawmi.daily_metrics WHERE day BETWEEN $1 AND $2", *days
        )
        await self.pool.execute("DELETE FROM yawmi.ai_insights WHERE day BETWEEN $1 AND $2", *days)
        await self.pool.execute("DELETE FROM yawmi.ai_consents")
        await self.pool.execute("DELETE FROM yawmi.ai_memory")
        await self.pool.execute("DELETE FROM yawmi.user_settings WHERE key = ANY($1)", SETTING_KEYS)

    # --- what grounding reads besides the goals backend -------------------------------------

    async def journal_entry(self, day: date, part: str, answers: dict[str, Any]) -> None:
        if self.pool is None:
            await self.journal.add_entry(day, part, answers)
            return
        await self.pool.execute(
            "INSERT INTO yawmi.journal_entries (day, part, answers, logged_at)"
            " VALUES ($1, $2, $3::jsonb, now())",
            day,
            part,
            json.dumps(answers, ensure_ascii=False),
        )

    async def mood(self, day: date, score: int, feelings: list[str]) -> None:
        if self.pool is None:
            self.journal.mood_rows.append(MoodRow(day, score, feelings, []))
            return
        await self.pool.execute(
            "INSERT INTO yawmi.mood_logs (day, score, feelings, logged_at)"
            " VALUES ($1, $2, $3::jsonb, now())",
            day,
            score,
            json.dumps(feelings, ensure_ascii=False),
        )

    async def focus(self, day: date, minutes: float) -> None:
        if self.pool is None:
            self.sessions.focus.append(SessionDay(day, 1, minutes))
            return
        started = datetime(day.year, day.month, day.day, 6, 0, tzinfo=UTC)
        await self.pool.execute(
            "INSERT INTO yawmi.focus_sessions (id, day, started_at, ended_at, planned_minutes,"
            " actual_minutes) VALUES ($1, $2, $3, $3, 25, $4)",
            uuid4(),
            day,
            started,
            Decimal(str(minutes)),
        )

    async def breath(self, day: date, seconds: int) -> None:
        if self.pool is None:
            self.sessions.breath.append(SessionDay(day, 1, seconds / 60))
            return
        started = datetime(day.year, day.month, day.day, 7, 0, tzinfo=UTC)
        await self.pool.execute(
            "INSERT INTO yawmi.breath_sessions (id, day, started_at, ended_at, pattern,"
            " duration_seconds) VALUES ($1, $2, $3, $3, 'box', $4)",
            uuid4(),
            day,
            started,
            seconds,
        )

    async def metrics(self, day: date, recovery: int) -> None:
        if self.pool is None:
            self.goals.today.metrics.append(MetricsRow(day, recovery, None, 420, "ok"))
            return
        await self.pool.execute(
            "INSERT INTO yawmi.daily_metrics (day, recovery_score, sleep_minutes, data_quality)"
            " VALUES ($1, $2, 420, 'ok')",
            day,
            recovery,
        )

    async def consent_row(self, provider: str) -> Consent | None:
        return await self.consents.get(provider)

    async def grant(self, provider: str = "anthropic", personal_text: bool = False) -> None:
        await self.consents.grant(provider, personal_text, DEVICE, datetime.now(UTC))

    async def insight_count(self) -> int:
        if self.pool is None:
            return len(self.insights.rows)
        return int(await self.pool.fetchval("SELECT count(*) FROM yawmi.ai_insights"))

    async def stored(self, kind: str, day: date) -> list[StoredInsight]:
        rows = await self.insights.list_reviews(kind, 50, None)
        return [r for r in rows if r.day == day]

    async def seed_insight(self, kind: str, day: date, cards: list[SourceCard]) -> StoredInsight:
        reply = InsightResponse(lines=["سطر."], question=None, source_ids=[], priorities=[])
        row = new_insight(kind, day, "anthropic", "m", "h" * 64, reply, cards=cards)  # type: ignore[arg-type]
        return await self.insights.save_first(row)


@pytest.fixture
async def ai(goals_backend: GoalsBackend) -> AsyncIterator[AiBackend]:
    backend = AiBackend(goals_backend)
    await backend.setup()
    try:
        yield backend
    finally:
        await backend.cleanup()


def build_ai_app(backend: AiBackend, **overrides: Any) -> FastAPI:
    app = create_app(settings=make_settings(**overrides), devices=InMemoryDeviceStore())
    backend.install(app)
    return app


@pytest.fixture
async def ai_client(ai: AiBackend) -> AsyncIterator[httpx.AsyncClient]:
    app = build_ai_app(ai)
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.app = app  # type: ignore[attr-defined]
        yield c
