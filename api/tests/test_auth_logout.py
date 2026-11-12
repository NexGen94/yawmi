"""`POST /v1/auth/logout` tests on both backends (memory and Postgres)."""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr
from test_journal import SECRET, open_pg_pool  # type: ignore[import-not-found]

from yawmi.auth.deps import DeviceStore
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.pg_store import AsyncpgDeviceStore
from yawmi.db.pool import set_pool
from yawmi.main import create_app
from yawmi.settings import Settings


@pytest.fixture(params=["memory", "postgres"])
async def store(request: pytest.FixtureRequest) -> AsyncIterator[DeviceStore]:
    if request.param == "memory":
        yield InMemoryDeviceStore()
        return
    pool = await open_pg_pool()
    set_pool(pool)
    try:
        yield AsyncpgDeviceStore(pool)
    finally:
        set_pool(None)
        await pool.close()


@pytest.fixture
async def client(store: DeviceStore) -> AsyncIterator[httpx.AsyncClient]:
    app: FastAPI = create_app(
        settings=Settings(
            database_url="postgresql://yawmi_api@localhost:5432/raqib",
            jwt_secret=SecretStr(SECRET),
            cookie_secure=True,
        ),
        devices=store,
    )
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


async def test_logout_leaves_other_devices_untouched(
    client: httpx.AsyncClient, store: DeviceStore
) -> None:
    code_a = f"{uuid4().int % 100_000_000:08d}"
    code_b = f"{uuid4().int % 100_000_000:08d}"
    assert await store.add_pairing_code(code_a, "web", datetime.now(UTC) + timedelta(minutes=10))
    assert await store.add_pairing_code(code_b, "iphone", datetime.now(UTC) + timedelta(minutes=10))

    paired_a = await client.post(
        "/v1/devices/pair", json={"code": code_a, "name": "متصفح A", "kind": "web"}
    )
    assert paired_a.status_code == 200
    cookie_a = cookie_pair(paired_a)

    paired_b = (
        await client.post(
            "/v1/devices/pair", json={"code": code_b, "name": "آيفون B", "kind": "iphone"}
        )
    ).json()

    # Logout device A
    logout_a = await client.post("/v1/auth/logout", headers={"Cookie": cookie_a})
    assert logout_a.status_code == 204

    # Device A is revoked
    refresh_a = await client.post("/v1/auth/refresh", headers={"Cookie": cookie_a})
    assert refresh_a.status_code == 401

    # Device B is untouched and refreshes successfully
    refresh_b = await client.post(
        "/v1/auth/refresh",
        json={"device_id": paired_b["device_id"], "refresh_token": paired_b["refresh_token"]},
    )
    assert refresh_b.status_code == 200
    assert "access_token" in refresh_b.json()
