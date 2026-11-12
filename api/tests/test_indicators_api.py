"""Tests for `GET`, `PUT`, and `DELETE` `/v1/indicators` (memory and Postgres backends)."""

import os
from collections.abc import AsyncIterator
from typing import Protocol
from uuid import UUID

import asyncpg
import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.db.pool import create_pool, set_pool
from yawmi.indicators.memory import InMemoryIndicatorStore
from yawmi.indicators.store import AsyncpgIndicatorStore
from yawmi.main import create_app
from yawmi.settings import Settings

SECRET = "test-secret-for-unit-tests-only-0123456789"
DEVICE_ID = UUID("00000000-0000-7000-8000-000000000402")
IN_CI = bool(os.environ.get("CI"))
DSN = os.environ.get("TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(
    not DSN and not IN_CI, reason="TEST_DATABASE_URL is not set (database tests run in CI)"
)


class Backend(Protocol):
    def install(self, app: FastAPI) -> None: ...
    async def setup(self) -> None: ...
    async def cleanup(self) -> None: ...


class MemoryBackend:
    def __init__(self) -> None:
        self.indicators = InMemoryIndicatorStore()

    def install(self, app: FastAPI) -> None:
        app.state.indicators = self.indicators

    async def setup(self) -> None:
        pass

    async def cleanup(self) -> None:
        self.indicators = InMemoryIndicatorStore()


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.indicators = AsyncpgIndicatorStore(pool)

    def install(self, app: FastAPI) -> None:
        app.state.indicators = self.indicators

    async def setup(self) -> None:
        await self.cleanup()
        await self.pool.execute(
            "INSERT INTO yawmi.devices (id, name, kind, paired_at) VALUES ($1, $2, 'web', now())"
            " ON CONFLICT (id) DO NOTHING",
            DEVICE_ID,
            "t10 indicators test device",
        )

    async def cleanup(self) -> None:
        await self.pool.execute("DELETE FROM yawmi.indicators")


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    if request.param == "memory":
        b: Backend = MemoryBackend()
        await b.setup()
        yield b
        await b.cleanup()
        return
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not")
        pytest.skip("TEST_DATABASE_URL is not set (database tests run in CI)")
    pool = await create_pool(url)
    set_pool(pool)
    try:
        b = PostgresBackend(pool)
        await b.setup()
        yield b
        await b.cleanup()
    finally:
        set_pool(None)
        await pool.close()


@pytest.fixture
def app(backend: Backend) -> FastAPI:
    settings = Settings(
        database_url="postgresql://yawmi_api@localhost:5432/raqib",
        jwt_secret=SecretStr(SECRET),
    )
    devices = InMemoryDeviceStore()
    app = create_app(settings=settings, devices=devices)
    backend.install(app)
    return app


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def auth_header(device_id: UUID = DEVICE_ID, kind: str = "web") -> dict[str, str]:
    token = issue_access(device_id, kind, SECRET, 3600)
    return {"Authorization": f"Bearer {token}"}


async def test_habit_indicator_validation_errors(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    # habit with source "milestones" -> 422
    resp = await client.put(
        "/v1/indicators/habit/reading",
        json={
            "subject_kind": "habit",
            "subject_ref": "reading",
            "source": "milestones",
            "measure": "completion",
            "period": "week",
            "display": "ring",
        },
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text

    # habit with reminder -> 422
    resp = await client.put(
        "/v1/indicators/habit/reading",
        json={
            "subject_kind": "habit",
            "subject_ref": "reading",
            "source": "habit_logs",
            "measure": "completion",
            "period": "week",
            "display": "ring",
            "reminder": {"time": "20:00", "days_mask": 127},
        },
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text


async def test_goal_indicator_crud_and_deduplication(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    # Initially empty list
    get_resp = await client.get("/v1/indicators", headers=auth_header())
    assert get_resp.status_code == 200
    assert get_resp.json() == {"items": []}

    # goal with tasks and reminder -> 200
    item = {
        "subject_kind": "goal",
        "subject_ref": "O1",
        "title_ar": "مؤشر الهدف الصحي",
        "source": "tasks",
        "measure": "completion",
        "target": 10.0,
        "period": "cycle",
        "display": "bar",
        "reminder": {"time": "20:00", "days_mask": 127},
    }
    put_resp = await client.put("/v1/indicators/goal/O1", json=item, headers=auth_header())
    assert put_resp.status_code == 200, put_resp.text
    saved = put_resp.json()
    assert saved["subject_kind"] == "goal"
    assert saved["subject_ref"] == "O1"
    assert saved["reminder"] == {"time": "20:00", "days_mask": 127}

    # PUT second time with updated title keeps exactly one row
    item["title_ar"] = "عنوان معدل"
    put_resp2 = await client.put("/v1/indicators/goal/O1", json=item, headers=auth_header())
    assert put_resp2.status_code == 200
    assert put_resp2.json()["title_ar"] == "عنوان معدل"

    list_resp = await client.get("/v1/indicators", headers=auth_header())
    assert list_resp.status_code == 200
    items = list_resp.json()["items"]
    assert len(items) == 1
    assert items[0]["title_ar"] == "عنوان معدل"

    # DELETE -> 204
    del_resp = await client.delete("/v1/indicators/goal/O1", headers=auth_header())
    assert del_resp.status_code == 204

    # List is now empty
    list_resp_after = await client.get("/v1/indicators", headers=auth_header())
    assert list_resp_after.status_code == 200
    assert list_resp_after.json() == {"items": []}
