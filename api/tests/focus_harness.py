"""One backend for the focus and breath API tests: in-memory stores or Postgres rows.

The memory backend reads the sessions the in-memory event store projected; the Postgres one
reads the real tables. `post_events` sends events through `POST /v1/events`, as a client would.
"""

from collections.abc import AsyncIterator
from typing import Any, Protocol
from uuid import UUID, uuid4

import asyncpg
import httpx
import pytest
from api_harness import auth_header, build_app, http_client, open_backend
from fastapi import FastAPI
from goals_harness import ensure_schema

from yawmi.events.memory_store import InMemoryEventStore
from yawmi.focus.memory import InMemoryFocusStore
from yawmi.focus.store import AsyncpgFocusStore

DEVICE_ID = UUID("00000000-0000-7000-8000-000000000422")


class Backend(Protocol):
    focus: Any

    def install(self, app: FastAPI) -> None: ...
    async def setup(self) -> None: ...
    async def cleanup(self) -> None: ...
    async def new_habit(self) -> str: ...


class MemoryBackend:
    def __init__(self) -> None:
        self.events = InMemoryEventStore()
        self.focus = InMemoryFocusStore(events=self.events)

    def install(self, app: FastAPI) -> None:
        app.state.events = self.events
        app.state.focus = self.focus

    async def setup(self) -> None:
        pass

    async def cleanup(self) -> None:
        pass

    async def new_habit(self) -> str:
        code = f"t22-{uuid4().hex[:8]}"
        self.events.habits.add(code)
        return code


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.focus = AsyncpgFocusStore(pool)

    def install(self, app: FastAPI) -> None:
        pass

    async def setup(self) -> None:
        await ensure_schema(self.pool)
        await self.cleanup()
        await self.pool.execute(
            "INSERT INTO yawmi.devices (id, name, kind, paired_at) VALUES ($1, $2, 'web', now())"
            " ON CONFLICT (id) DO NOTHING",
            DEVICE_ID,
            "t22 focus test device",
        )

    async def cleanup(self) -> None:
        await self.pool.execute("DELETE FROM yawmi.focus_plans")
        await self.pool.execute("DELETE FROM yawmi.focus_sessions WHERE device_id = $1", DEVICE_ID)
        await self.pool.execute("DELETE FROM yawmi.breath_sessions WHERE device_id = $1", DEVICE_ID)
        await self.pool.execute("DELETE FROM yawmi.events WHERE device_id = $1", DEVICE_ID)
        await self.pool.execute("DELETE FROM yawmi.habits WHERE code LIKE 't22-%'")
        await self.pool.execute("DELETE FROM yawmi.devices WHERE id = $1", DEVICE_ID)

    async def new_habit(self) -> str:
        code = f"t22-{uuid4().hex[:8]}"
        await self.pool.execute(
            "INSERT INTO yawmi.habits (code, title_ar, kind, target_per_period, period, start_day,"
            " created_by) VALUES ($1, 'عادة اختبار', 'count', 1, 'day', date '2026-01-01', 'user')",
            code,
        )
        return code


@pytest.fixture(params=["memory", "postgres"])
async def focus_backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    async with open_backend(request.param, MemoryBackend, PostgresBackend) as b:
        yield b


@pytest.fixture
def focus_app(focus_backend: Backend) -> FastAPI:
    return build_app(focus_backend.install)


@pytest.fixture
async def focus_client(focus_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(focus_app) as c:
        yield c


def auth(kind: str = "web") -> dict[str, str]:
    return auth_header(DEVICE_ID, kind)


def event(type_: str, payload: dict[str, Any], at: str = "2026-11-10T06:00:00Z") -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "type": type_,
        "payload": payload,
        "occurred_at": at,
        "tz": "Asia/Riyadh",
    }


async def post_events(client: httpx.AsyncClient, *events: dict[str, Any]) -> None:
    resp = await client.post("/v1/events", json={"events": list(events)}, headers=auth())
    assert resp.status_code == 200, resp.text
