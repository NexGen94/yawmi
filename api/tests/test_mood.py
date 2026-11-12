"""`mood_logged` event projection and `GET /v1/mood` on both backends (memory and Postgres)."""

import os
from collections.abc import AsyncIterator
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
DEVICE_ID = UUID("00000000-0000-7000-8000-000000000302")
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
            "t03 mood test device",
        )

    async def cleanup(self) -> None:
        await self.pool.execute(
            "DELETE FROM yawmi.mood_logs WHERE day BETWEEN '2026-11-01' AND '2026-11-20'"
        )
        await self.pool.execute("DELETE FROM yawmi.events WHERE device_id = $1", DEVICE_ID)
        await self.pool.execute("DELETE FROM yawmi.devices WHERE id = $1", DEVICE_ID)


async def ensure_schema(pool: asyncpg.Pool) -> None:
    await pool.execute(STUB_SQL.read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.events') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0001_yawmi_schema.sql").read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.mood_logs') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0002_yawmi_role.sql").read_text(encoding="utf-8"))
        await pool.execute((MIGRATIONS / "0003_yawmi_web.sql").read_text(encoding="utf-8"))


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    if request.param == "memory":
        yield MemoryBackend()
        return
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await ensure_schema(pool)
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
def app(backend: Backend) -> FastAPI:
    application = create_app(
        settings=Settings(
            database_url="postgresql://yawmi_api@localhost:5432/raqib",
            jwt_secret=SecretStr(SECRET),
        ),
        devices=InMemoryDeviceStore(),
    )
    backend.install(application)
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def auth(kind: str = "web") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(DEVICE_ID, kind, SECRET, 900)}"}


def mood_event(payload: dict[str, Any], *, at: str = "2026-11-10T18:00:00Z") -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "type": "mood_logged",
        "payload": payload,
        "occurred_at": at,
        "tz": "Asia/Riyadh",
    }


async def test_mood_event_is_returned_by_get_mood_with_numeric_score(
    client: httpx.AsyncClient,
) -> None:
    ev = mood_event(
        {
            "score": 4,
            "feelings": ["calm", "grateful"],
            "activities": ["walk"],
        }
    )
    post_res = await client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert post_res.status_code == 200, post_res.text

    res = await client.get(
        "/v1/mood", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res.status_code == 200, res.text
    logs = res.json()["logs"]
    assert len(logs) == 1
    log = logs[0]
    assert log == {
        "day": "2026-11-10",
        "score": 4,
        "feelings": ["calm", "grateful"],
        "activities": ["walk"],
    }
    assert isinstance(log["score"], int) and not isinstance(log["score"], bool)


async def test_mood_newest_event_wins_per_day(client: httpx.AsyncClient) -> None:
    first = mood_event({"score": 4, "feelings": ["calm"]}, at="2026-11-10T18:00:00Z")
    older = mood_event({"score": 2, "feelings": ["tired"]}, at="2026-11-10T17:00:00Z")
    newer = mood_event({"score": 5, "feelings": ["grateful"]}, at="2026-11-10T19:00:00Z")

    assert (
        await client.post("/v1/events", json={"events": [first]}, headers=auth())
    ).status_code == 200
    assert (
        await client.post("/v1/events", json={"events": [older]}, headers=auth())
    ).status_code == 200
    res1 = await client.get(
        "/v1/mood", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res1.json()["logs"][0]["score"] == 4

    assert (
        await client.post("/v1/events", json={"events": [newer]}, headers=auth())
    ).status_code == 200
    res2 = await client.get(
        "/v1/mood", params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert res2.json()["logs"][0]["score"] == 5
    assert res2.json()["logs"][0]["feelings"] == ["grateful"]


@pytest.mark.parametrize(
    "payload",
    [
        {"score": 6},
        {"score": 0},
        {"score": 4, "feelings": ["f1", "f2", "f3", "f4", "f5", "f6", "f7"]},
        {"score": 4, "feelings": ["x" * 25]},
        {"score": 4, "activities": [f"a{i}" for i in range(13)]},
    ],
    ids=["score-6", "score-0", "seven-feelings", "feeling-too-long", "thirteen-activities"],
)
async def test_invalid_mood_payloads_are_rejected(
    client: httpx.AsyncClient, payload: dict[str, Any]
) -> None:
    ev = mood_event(payload)
    res = await client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert res.status_code == 422
