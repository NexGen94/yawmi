"""Tests for `GET /v1/settings` and `PATCH /v1/settings` (memory and Postgres backends)."""

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
from yawmi.main import create_app
from yawmi.prefs.memory import InMemoryPrefsStore
from yawmi.prefs.store import AsyncpgPrefsStore
from yawmi.settings import Settings

SECRET = "test-secret-for-unit-tests-only-0123456789"
DEVICE_ID = UUID("00000000-0000-7000-8000-000000000401")
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
        self.prefs = InMemoryPrefsStore()

    def install(self, app: FastAPI) -> None:
        app.state.prefs = self.prefs

    async def setup(self) -> None:
        pass

    async def cleanup(self) -> None:
        self.prefs = InMemoryPrefsStore()


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.prefs = AsyncpgPrefsStore(pool)

    def install(self, app: FastAPI) -> None:
        app.state.prefs = self.prefs

    async def setup(self) -> None:
        await self.cleanup()
        await self.pool.execute(
            "INSERT INTO yawmi.devices (id, name, kind, paired_at) VALUES ($1, $2, 'web', now())"
            " ON CONFLICT (id) DO NOTHING",
            DEVICE_ID,
            "t10 settings test device",
        )

    async def cleanup(self) -> None:
        await self.pool.execute("DELETE FROM yawmi.user_settings")


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


async def test_initial_settings_returns_defaults(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    resp = await client.get("/v1/settings", headers=auth_header())
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["mission"] == ""
    assert data["vision"] == ""
    assert data["digits"] == "latn"
    assert data["ai_lines"] == 2
    assert data["ai_tone"] == "direct"
    assert data["ai_checkin"] == "evening"
    assert data["day_reminders"] == {"morning": None, "evening": None, "weekly": None}
    assert data["late_notice_enabled"] is True
    assert data["late_notice_time"] == "20:00"
    assert data["goal_columns"]["outcomes"] == [
        "code",
        "title",
        "completion",
        "next_milestone",
        "target_date",
    ]
    assert data["goal_columns"]["milestones"] == [
        "title",
        "outcome_code",
        "due_date",
        "done",
        "cycle_no",
    ]
    assert data["goal_columns"]["cards"] == [
        "title",
        "status",
        "outcome_codes",
        "target_date",
        "next_step",
        "milestones_done",
    ]
    assert data["focus_daily_target_min"] is None
    assert data["breath_weekly_target_min"] is None
    assert data["breath_prefs"] is None


async def test_patch_settings_persists_and_preserves_other_keys(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    patch_resp = await client.patch(
        "/v1/settings",
        json={"mission": "نص رسالتي في الحياة"},
        headers=auth_header(),
    )
    assert patch_resp.status_code == 200, patch_resp.text
    assert patch_resp.json()["mission"] == "نص رسالتي في الحياة"
    assert patch_resp.json()["digits"] == "latn"

    get_resp = await client.get("/v1/settings", headers=auth_header())
    assert get_resp.status_code == 200
    assert get_resp.json()["mission"] == "نص رسالتي في الحياة"
    assert get_resp.json()["digits"] == "latn"
    assert get_resp.json()["ai_lines"] == 2


async def test_settings_validation_errors(client: httpx.AsyncClient, backend: Backend) -> None:
    # 601 characters for mission
    resp = await client.patch("/v1/settings", json={"mission": "أ" * 601}, headers=auth_header())
    assert resp.status_code == 422, resp.text

    # ai_lines: 3
    resp = await client.patch("/v1/settings", json={"ai_lines": 3}, headers=auth_header())
    assert resp.status_code == 422, resp.text

    # digits: "x"
    resp = await client.patch("/v1/settings", json={"digits": "x"}, headers=auth_header())
    assert resp.status_code == 422, resp.text

    # check_text on text field (e.g. control character)
    resp = await client.patch("/v1/settings", json={"mission": "نص\x00خبيث"}, headers=auth_header())
    assert resp.status_code == 422, resp.text


async def test_breath_prefs_validation(client: httpx.AsyncClient, backend: Backend) -> None:
    # Valid
    valid_prefs = {"rate": 6.0, "pattern": "calm", "minutes": 5, "sound": True}
    resp = await client.patch(
        "/v1/settings", json={"breath_prefs": valid_prefs}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["breath_prefs"] == valid_prefs

    # rate: 4
    resp = await client.patch(
        "/v1/settings",
        json={"breath_prefs": {"rate": 4.0, "pattern": "calm", "minutes": 5, "sound": True}},
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text

    # rate: 8
    resp = await client.patch(
        "/v1/settings",
        json={"breath_prefs": {"rate": 8.0, "pattern": "calm", "minutes": 5, "sound": True}},
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text

    # minutes: 11
    resp = await client.patch(
        "/v1/settings",
        json={"breath_prefs": {"rate": 6.0, "pattern": "calm", "minutes": 11, "sound": True}},
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text

    # pattern: "box"
    resp = await client.patch(
        "/v1/settings",
        json={"breath_prefs": {"rate": 6.0, "pattern": "box", "minutes": 5, "sound": True}},
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text
