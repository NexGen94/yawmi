"""`journal_saved` event projection and `GET /v1/journal` on both backends (memory and Postgres)."""

import logging
import os
from collections.abc import AsyncIterator
from datetime import date
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID, uuid4

import asyncpg
import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.db.pool import create_pool, set_pool
from yawmi.events.memory_store import InMemoryEventStore
from yawmi.journal.memory import InMemoryJournalReader
from yawmi.main import create_app
from yawmi.settings import Settings

SECRET = "test-secret-for-unit-tests-only-0123456789"
DEVICE_ID = UUID("00000000-0000-7000-8000-000000000301")
IN_CI = bool(os.environ.get("CI"))
MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"
STUB_SQL = Path(__file__).parent / "fixtures" / "raqib_stub.sql"


class Backend(Protocol):
    def install(self, app: FastAPI) -> None: ...


class MemoryBackend:
    def __init__(self) -> None:
        self.events = InMemoryEventStore()
        self.journal = InMemoryJournalReader(events=self.events)

    def install(self, app: FastAPI) -> None:
        app.state.events = self.events
        app.state.journal = self.journal


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    def install(self, app: FastAPI) -> None:
        pass

    async def setup(self) -> None:
        await self.cleanup()
        await self.pool.execute(
            "INSERT INTO yawmi.devices (id, name, kind, paired_at) VALUES ($1, $2, 'web', now())"
            " ON CONFLICT (id) DO NOTHING",
            DEVICE_ID,
            "t03 journal test device",
        )

    async def cleanup(self) -> None:
        await self.pool.execute(
            "DELETE FROM yawmi.journal_entries WHERE day BETWEEN '2026-11-01' AND '2026-11-20'"
        )
        await self.pool.execute(
            "DELETE FROM yawmi.mood_logs WHERE day BETWEEN '2026-11-01' AND '2026-11-20'"
        )
        await self.pool.execute("DELETE FROM yawmi.events WHERE device_id = $1", DEVICE_ID)
        await self.pool.execute("DELETE FROM yawmi.devices WHERE id = $1", DEVICE_ID)


async def open_pg_pool() -> asyncpg.Pool:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await pool.execute(STUB_SQL.read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.events') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0001_yawmi_schema.sql").read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.journal_entries') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0002_yawmi_role.sql").read_text(encoding="utf-8"))
        await pool.execute((MIGRATIONS / "0003_yawmi_web.sql").read_text(encoding="utf-8"))
    return pool


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    if request.param == "memory":
        yield MemoryBackend()
        return
    pool = await open_pg_pool()
    pg = PostgresBackend(pool)
    await pg.setup()
    set_pool(pool)
    try:
        yield pg
    finally:
        set_pool(None)
        await pg.cleanup()
        await pool.close()


@pytest.fixture
async def client(backend: Backend) -> AsyncIterator[httpx.AsyncClient]:
    cfg = Settings(
        database_url="postgresql://yawmi_api@localhost:5432/raqib",
        jwt_secret=SecretStr(SECRET),
    )
    application = create_app(settings=cfg, devices=InMemoryDeviceStore())
    backend.install(application)
    async with httpx.AsyncClient(
        transport=ASGITransport(app=application), base_url="http://test"
    ) as c:
        yield c


def auth(kind: str = "web") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(DEVICE_ID, kind, SECRET, 900)}"}


def journal_event(
    part: str,
    answers: dict[str, Any],
    *,
    at: str = "2026-11-10T04:00:00Z",
    day: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"part": part, "answers": answers}
    if day is not None:
        payload["day"] = day
    return {
        "id": str(uuid4()),
        "type": "journal_saved",
        "payload": payload,
        "occurred_at": at,
        "tz": "Asia/Riyadh",
    }


async def test_morning_journal_event_is_returned_by_get_journal(
    client: httpx.AsyncClient,
) -> None:
    ev = journal_event(
        "morning",
        {
            "priorities": [{"title": "إنهاء الفصل الأول", "goal_ref": "O7"}],
            "planned_minutes": 90,
            "enthusiasm": "واضح",
            "gratitude": ["صحة جيدة"],
            "note": "بداية هادئة",
        },
        at="2026-11-10T04:00:00Z",
    )
    post_res = await client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert post_res.status_code == 200, post_res.text

    res = await client.get(
        "/v1/journal", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res.status_code == 200, res.text
    entries = res.json()["entries"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry["day"] == "2026-11-10"
    assert entry["part"] == "morning"
    assert entry["answers"]["planned_minutes"] == 90
    assert entry["answers"]["priorities"] == [{"title": "إنهاء الفصل الأول", "goal_ref": "O7"}]
    assert entry["answers"]["gratitude"] == ["صحة جيدة"]


async def test_older_journal_event_does_not_overwrite_and_newer_replaces(
    client: httpx.AsyncClient,
) -> None:
    first = journal_event("morning", {"planned_minutes": 60}, at="2026-11-10T05:00:00Z")
    older = journal_event("morning", {"planned_minutes": 30}, at="2026-11-10T04:00:00Z")
    newer = journal_event("morning", {"planned_minutes": 120}, at="2026-11-10T06:00:00Z")

    assert (
        await client.post("/v1/events", json={"events": [first]}, headers=auth())
    ).status_code == 200
    assert (
        await client.post("/v1/events", json={"events": [older]}, headers=auth())
    ).status_code == 200

    res1 = await client.get(
        "/v1/journal", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res1.json()["entries"][0]["answers"]["planned_minutes"] == 60

    assert (
        await client.post("/v1/events", json={"events": [newer]}, headers=auth())
    ).status_code == 200
    res2 = await client.get(
        "/v1/journal", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res2.json()["entries"][0]["answers"]["planned_minutes"] == 120


async def test_journal_event_without_day_uses_local_riyadh_day(
    client: httpx.AsyncClient,
) -> None:
    # 2026-11-09T23:30:00Z is 2026-11-10T02:30:00+03:00 in Asia/Riyadh
    ev = journal_event("morning", {"planned_minutes": 45}, at="2026-11-09T23:30:00Z")
    res = await client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert res.status_code == 200, res.text

    got = await client.get(
        "/v1/journal", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    entries = got.json()["entries"]
    assert len(entries) == 1
    assert entries[0]["day"] == "2026-11-10"


@pytest.mark.parametrize(
    ("part", "answers"),
    [
        (
            "morning",
            {
                "priorities": [
                    {"title": "1"},
                    {"title": "2"},
                    {"title": "3"},
                    {"title": "4"},
                ]
            },
        ),
        ("morning", {"planned_minutes": 1441}),
        ("evening", {"calm": 11}),
        ("evening", {"planned_minutes": 90}),
    ],
    ids=["four-priorities", "planned-minutes-1441", "calm-11", "evening-with-planned-minutes"],
)
async def test_invalid_journal_answers_are_rejected(
    client: httpx.AsyncClient, part: str, answers: dict[str, Any]
) -> None:
    ev = journal_event(part, answers)
    res = await client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert res.status_code == 422


async def test_journal_range_limit_and_auth(
    client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    assert (
        await client.get("/v1/journal", params={"from": "2026-11-01", "to": "2026-11-10"})
    ).status_code == 401
    assert (
        await client.get(
            "/v1/journal",
            params={"from": "2026-11-01", "to": "2026-11-10"},
            headers=auth("service"),
        )
    ).status_code == 403

    too_wide = await client.get(
        "/v1/journal",
        params={"from": "2025-01-01", "to": date(2026, 2, 6).isoformat()},
        headers=auth(),
    )
    assert too_wide.status_code == 422
    assert too_wide.json()["errors"][0]["type"] == "range_too_large"

    secret_note = "مذكرة-شخصية-سرية-778899"
    with caplog.at_level(logging.DEBUG):
        ev = journal_event("evening", {"note": secret_note, "win": "إنجاز", "win_outcome": "O1"})
        assert (
            await client.post("/v1/events", json={"events": [ev]}, headers=auth())
        ).status_code == 200
        assert (
            await client.get(
                "/v1/journal", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
            )
        ).status_code == 200
    assert secret_note not in caplog.text
