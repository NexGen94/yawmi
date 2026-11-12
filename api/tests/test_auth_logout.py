"""`POST /v1/auth/logout` tests on both backends (memory and Postgres)."""

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import asyncpg
import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.auth.deps import DeviceStore
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.pg_store import AsyncpgDeviceStore
from yawmi.db.pool import create_pool, set_pool
from yawmi.main import create_app
from yawmi.settings import Settings

SECRET = "test-secret-for-unit-tests-only-0123456789"
IN_CI = bool(os.environ.get("CI"))
MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"
STUB_SQL = Path(__file__).parent / "fixtures" / "raqib_stub.sql"


async def ensure_schema(pool: asyncpg.Pool) -> None:
    await pool.execute(STUB_SQL.read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.devices') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0001_yawmi_schema.sql").read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.journal_entries') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0002_yawmi_role.sql").read_text(encoding="utf-8"))
        await pool.execute((MIGRATIONS / "0003_yawmi_web.sql").read_text(encoding="utf-8"))


@pytest.fixture(params=["memory", "postgres"])
async def store(request: pytest.FixtureRequest) -> AsyncIterator[DeviceStore]:
    if request.param == "memory":
        yield InMemoryDeviceStore()
        return
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await ensure_schema(pool)
    set_pool(pool)
    try:
        yield AsyncpgDeviceStore(pool)
    finally:
        set_pool(None)
        await pool.close()


@pytest.fixture
def app(store: DeviceStore) -> FastAPI:
    return create_app(
        settings=Settings(
            database_url="postgresql://yawmi_api@localhost:5432/raqib",
            jwt_secret=SecretStr(SECRET),
            cookie_secure=True,
        ),
        devices=store,
    )


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def cookie_pair(response: httpx.Response) -> str:
    return response.headers["set-cookie"].split(";", 1)[0].strip()


def cookie_attrs(response: httpx.Response) -> set[str]:
    parts = [p.strip() for p in response.headers["set-cookie"].split(";")]
    return {p.lower() for p in parts[1:]}


async def test_logout_revokes_session_clears_cookie_and_is_idempotent(
    client: httpx.AsyncClient, store: DeviceStore
) -> None:
    code = f"{uuid4().int % 100_000_000:08d}"
    assert await store.add_pairing_code(code, "web", datetime.now(UTC) + timedelta(minutes=10))
    paired = await client.post(
        "/v1/devices/pair", json={"code": code, "name": "متصفح الحاسوب", "kind": "web"}
    )
    assert paired.status_code == 200
    rt_cookie = cookie_pair(paired)

    out = await client.post("/v1/auth/logout", headers={"Cookie": rt_cookie})
    assert out.status_code == 204
    assert "set-cookie" in out.headers
    assert out.headers["set-cookie"].startswith("yawmi_rt=")
    attrs = cookie_attrs(out)
    assert "max-age=0" in attrs
    assert "path=/v1/auth" in attrs

    refresh = await client.post("/v1/auth/refresh", headers={"Cookie": rt_cookie})
    assert refresh.status_code == 401

    second = await client.post("/v1/auth/logout", headers={"Cookie": rt_cookie})
    assert second.status_code == 204


async def test_logout_with_wrong_refresh_token_does_not_revoke_device(
    client: httpx.AsyncClient, store: DeviceStore
) -> None:
    code = f"{uuid4().int % 100_000_000:08d}"
    assert await store.add_pairing_code(code, "iphone", datetime.now(UTC) + timedelta(minutes=10))
    paired = (
        await client.post(
            "/v1/devices/pair", json={"code": code, "name": "آيفون", "kind": "iphone"}
        )
    ).json()

    wrong = await client.post(
        "/v1/auth/logout",
        json={"device_id": paired["device_id"], "refresh_token": "wrong-token-value"},
    )
    assert wrong.status_code == 204

    still_valid = await client.post(
        "/v1/auth/refresh",
        json={"device_id": paired["device_id"], "refresh_token": paired["refresh_token"]},
    )
    assert still_valid.status_code == 200
    rotated_rt = still_valid.json()["refresh_token"]

    ok = await client.post(
        "/v1/auth/logout",
        json={"device_id": paired["device_id"], "refresh_token": rotated_rt},
    )
    assert ok.status_code == 204
    after = await client.post(
        "/v1/auth/refresh",
        json={"device_id": paired["device_id"], "refresh_token": rotated_rt},
    )
    assert after.status_code == 401
