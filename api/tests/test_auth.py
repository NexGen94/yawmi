"""Auth tests: access tokens, pairing, rotating refresh, web cookie, revoke.

Unit tests only: the app is built with the in-memory `DeviceStore`, so no database is touched.
"""

import hashlib
import logging
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
from fastapi import Depends, FastAPI
from freezegun import freeze_time
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi import __version__
from yawmi.auth.deps import current_device, require_kind
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.pg_store import AsyncpgDeviceStore
from yawmi.auth.tokens import (
    AccessClaims,
    AuthError,
    issue_access,
    new_refresh,
    verify_access,
)
from yawmi.db.pool import get_pool
from yawmi.main import app as module_app
from yawmi.main import create_app
from yawmi.settings import Settings

SECRET = "test-secret-for-unit-tests-only-0123456789"
TTL = 900
CODE = "12345678"
UNAUTHORIZED = {"detail": "غير مصرّح"}
FORBIDDEN = {"detail": "غير مسموح"}
BAD_CODE = {"detail": "الكود غير صالح أو منتهٍ"}
COOKIE_MAX_AGE = 90 * 86400


def make_settings(*, cookie_secure: bool = True) -> Settings:
    return Settings(
        database_url="postgresql://yawmi_api@localhost:5432/raqib",
        jwt_secret=SecretStr(SECRET),
        cookie_secure=cookie_secure,
    )


@pytest.fixture
def store() -> InMemoryDeviceStore:
    return InMemoryDeviceStore()


@pytest.fixture
def app(store: InMemoryDeviceStore) -> FastAPI:
    return create_app(settings=make_settings(), devices=store)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def seed_code(
    store: InMemoryDeviceStore,
    kind: str = "iphone",
    *,
    code: str = CODE,
    ttl: timedelta = timedelta(minutes=10),
) -> str:
    assert await store.add_pairing_code(code, kind, datetime.now(UTC) + ttl)
    return code


async def pair(
    client: httpx.AsyncClient, code: str = CODE, kind: str = "iphone", name: str = "جهاز الاختبار"
) -> httpx.Response:
    return await client.post("/v1/devices/pair", json={"code": code, "name": name, "kind": kind})


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def service_token() -> str:
    return issue_access(uuid4(), "service", SECRET, TTL)


def cookie_pair(response: httpx.Response) -> str:
    """`yawmi_rt=<value>` taken from the response's Set-Cookie header."""
    header = response.headers["set-cookie"]
    return header.split(";", 1)[0].strip()


def cookie_attrs(response: httpx.Response) -> set[str]:
    parts = [p.strip() for p in response.headers["set-cookie"].split(";")]
    return {p.lower() for p in parts[1:]}


# --- tokens -----------------------------------------------------------------------------------


def test_verify_returns_sub_kind_and_exp() -> None:
    device_id = uuid4()
    token = issue_access(device_id, "watch", SECRET, TTL)
    claims = verify_access(token, SECRET)
    assert isinstance(claims, AccessClaims)
    assert claims.sub == device_id
    assert claims.kind == "watch"
    assert claims.exp.tzinfo is not None
    remaining = claims.exp - datetime.now(UTC)
    assert timedelta(seconds=TTL - 5) < remaining <= timedelta(seconds=TTL)


def test_token_is_hs256() -> None:
    token = issue_access(uuid4(), "iphone", SECRET, TTL)
    assert jwt.get_unverified_header(token)["alg"] == "HS256"


def test_expired_token_raises_auth_error() -> None:
    token = issue_access(uuid4(), "iphone", SECRET, -10)
    with pytest.raises(AuthError):
        verify_access(token, SECRET)


def test_token_expires_as_time_passes() -> None:
    with freeze_time("2026-11-10T10:00:00Z") as clock:
        token = issue_access(uuid4(), "iphone", SECRET, TTL)
        assert verify_access(token, SECRET).kind == "iphone"
        clock.tick(timedelta(seconds=TTL + 1))
        with pytest.raises(AuthError):
            verify_access(token, SECRET)


def test_wrong_secret_raises_auth_error() -> None:
    token = issue_access(uuid4(), "iphone", SECRET, TTL)
    with pytest.raises(AuthError):
        verify_access(token, SECRET + "x")


@pytest.mark.parametrize("garbage", ["", "abc", "a.b.c", "Bearer x"])
def test_garbage_token_raises_auth_error(garbage: str) -> None:
    with pytest.raises(AuthError):
        verify_access(garbage, SECRET)


def test_unsigned_token_is_rejected() -> None:
    exp = datetime.now(UTC) + timedelta(seconds=TTL)
    payload = {"sub": str(uuid4()), "kind": "service", "exp": exp}
    token = jwt.encode(payload, None, algorithm="none")
    with pytest.raises(AuthError):
        verify_access(token, SECRET)


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "iphone"},  # no sub
        {"sub": "not-a-uuid", "kind": "iphone"},
        {"sub": str(uuid4())},  # no kind
        {"sub": str(uuid4()), "kind": "admin"},  # unknown kind
    ],
)
def test_malformed_claims_raise_auth_error(payload: dict[str, str]) -> None:
    payload = {**payload, "exp": datetime.now(UTC) + timedelta(seconds=TTL)}
    token = jwt.encode(payload, SECRET, algorithm="HS256")
    with pytest.raises(AuthError):
        verify_access(token, SECRET)


def test_new_refresh_is_long_random_and_hashed_with_sha256() -> None:
    raw, digest = new_refresh()
    assert len(raw) >= 43
    assert digest == hashlib.sha256(raw.encode()).hexdigest()
    assert len(digest) == 64
    other_raw, other_digest = new_refresh()
    assert other_raw != raw
    assert other_digest != digest


# --- health, request id, logging ---------------------------------------------------------------


async def test_health_live_needs_no_auth(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/health/live")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


async def test_request_id_is_generated_when_absent(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/health/live")
    assert UUID(response.headers["x-request-id"]).version == 4


async def test_request_id_is_echoed_when_valid(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/health/live", headers={"X-Request-Id": "req-123.abc_DEF"})
    assert response.headers["x-request-id"] == "req-123.abc_DEF"


async def test_request_id_is_replaced_when_unsafe(client: httpx.AsyncClient) -> None:
    response = await client.get(
        "/v1/health/live", headers={"X-Request-Id": "bad value!" + "x" * 80}
    )
    assert UUID(response.headers["x-request-id"]).version == 4


def test_app_title_and_version(app: FastAPI) -> None:
    assert app.title == "yawmi-api"
    assert app.version == __version__


async def test_request_bodies_are_never_logged(
    client: httpx.AsyncClient, store: InMemoryDeviceStore, caplog: pytest.LogCaptureFixture
) -> None:
    await seed_code(store)
    secret_name = "اسم-سري-98765"
    with caplog.at_level(logging.DEBUG):
        response = await pair(client, name=secret_name)
    assert response.status_code == 200
    body = response.json()
    assert secret_name not in caplog.text
    assert CODE not in caplog.text
    assert body["access_token"] not in caplog.text
    assert body["refresh_token"] not in caplog.text
    access_lines = [r.getMessage() for r in caplog.records if r.name == "yawmi.access"]
    assert any("/v1/devices/pair" in line and "200" in line for line in access_lines)


# --- current_device / require_kind -------------------------------------------------------------


@pytest.fixture
def probe(app: FastAPI) -> FastAPI:
    @app.get("/v1/_probe/any")
    async def any_device(
        claims: Annotated[AccessClaims, Depends(current_device)],
    ) -> dict[str, str]:
        return {"sub": str(claims.sub), "kind": claims.kind}

    @app.get("/v1/_probe/service")
    async def service_only(
        claims: Annotated[AccessClaims, Depends(require_kind("service"))],
    ) -> dict[str, str]:
        return {"kind": claims.kind}

    return app


@pytest.mark.usefixtures("probe")
async def test_current_device_returns_claims(client: httpx.AsyncClient) -> None:
    device_id = uuid4()
    token = issue_access(device_id, "watch", SECRET, TTL)
    response = await client.get("/v1/_probe/any", headers=bearer(token))
    assert response.status_code == 200
    assert response.json() == {"sub": str(device_id), "kind": "watch"}


@pytest.mark.usefixtures("probe")
@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer not-a-jwt"},
        {"Authorization": "Basic Zm9vOmJhcg=="},
        {"Authorization": "Bearer"},
    ],
)
async def test_current_device_rejects_missing_or_bad_token(
    client: httpx.AsyncClient, headers: dict[str, str]
) -> None:
    response = await client.get("/v1/_probe/any", headers=headers)
    assert response.status_code == 401
    assert response.json() == UNAUTHORIZED


@pytest.mark.usefixtures("probe")
async def test_current_device_rejects_expired_token(client: httpx.AsyncClient) -> None:
    token = issue_access(uuid4(), "iphone", SECRET, -1)
    response = await client.get("/v1/_probe/any", headers=bearer(token))
    assert response.status_code == 401
    assert response.json() == UNAUTHORIZED


@pytest.mark.usefixtures("probe")
async def test_require_kind_allows_listed_and_rejects_others(client: httpx.AsyncClient) -> None:
    ok = await client.get("/v1/_probe/service", headers=bearer(service_token()))
    assert ok.status_code == 200
    denied = await client.get(
        "/v1/_probe/service", headers=bearer(issue_access(uuid4(), "iphone", SECRET, TTL))
    )
    assert denied.status_code == 403
    assert denied.json() == FORBIDDEN


# --- pairing -----------------------------------------------------------------------------------


async def test_pair_with_valid_code_returns_tokens(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "iphone")
    response = await pair(client, kind="iphone")
    assert response.status_code == 200
    body = response.json()
    device_id = UUID(body["device_id"])
    claims = verify_access(body["access_token"], SECRET)
    assert claims.sub == device_id
    assert claims.kind == "iphone"
    assert len(body["refresh_token"]) >= 43
    assert "set-cookie" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    device = await store.get_device(device_id)
    assert device is not None
    assert device.name == "جهاز الاختبار"
    assert device.kind == "iphone"
    assert device.revoked_at is None
    # only the hash is stored, never the raw refresh token
    assert device.refresh_hash == hashlib.sha256(body["refresh_token"].encode()).hexdigest()


async def test_pairing_code_is_single_use(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store)
    first = await pair(client)
    second = await pair(client)
    assert first.status_code == 200
    assert second.status_code == 400
    assert second.json() == BAD_CODE


async def test_expired_pairing_code_is_rejected(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, ttl=timedelta(seconds=-1))
    response = await pair(client)
    assert response.status_code == 400
    assert response.json() == BAD_CODE


async def test_unknown_pairing_code_is_rejected(client: httpx.AsyncClient) -> None:
    response = await pair(client, code="00000000")
    assert response.status_code == 400
    assert response.json() == BAD_CODE


async def test_pairing_code_kind_must_match_requested_kind(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "watch")
    response = await pair(client, kind="iphone")
    assert response.status_code == 400
    assert response.json() == BAD_CODE


async def test_service_kind_cannot_pair(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "iphone")
    response = await pair(client, kind="service")
    assert response.status_code == 403
    assert response.json() == FORBIDDEN
    # the rejected request did not burn the code
    assert (await pair(client, kind="iphone")).status_code == 200


async def test_pair_rejects_unknown_kind_and_missing_fields(client: httpx.AsyncClient) -> None:
    bad_kind = await client.post(
        "/v1/devices/pair", json={"code": CODE, "name": "x", "kind": "toaster"}
    )
    assert bad_kind.status_code == 422
    assert bad_kind.json()["detail"] == "طلب غير صالح"
    assert all(set(e) == {"loc", "type"} for e in bad_kind.json()["errors"])
    assert "toaster" not in bad_kind.text
    missing = await client.post("/v1/devices/pair", json={"code": CODE})
    assert missing.status_code == 422


# --- web: refresh token lives only in an HttpOnly cookie ---------------------------------------


async def test_web_pair_sets_cookie_and_hides_refresh_token(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "web")
    response = await pair(client, kind="web")
    assert response.status_code == 200
    body = response.json()
    assert body["refresh_token"] is None
    device_id = body["device_id"]
    assert verify_access(body["access_token"], SECRET).kind == "web"

    header = response.headers["set-cookie"]
    name, _, value = cookie_pair(response).partition("=")
    assert name == "yawmi_rt"
    value_device_id, _, raw = value.partition(".")
    assert value_device_id == device_id
    assert len(raw) >= 43
    attrs = cookie_attrs(response)
    assert "httponly" in attrs
    assert "secure" in attrs
    assert "samesite=strict" in attrs
    assert "path=/v1/auth" in attrs
    assert f"max-age={COOKIE_MAX_AGE}" in attrs
    # attribute spelling as the plan states it
    assert "HttpOnly" in header
    assert "Secure" in header
    assert "SameSite=Strict" in header
    assert "Path=/v1/auth" in header
    device = await store.get_device(UUID(device_id))
    assert device is not None
    assert device.refresh_hash == hashlib.sha256(raw.encode()).hexdigest()


async def test_cookie_secure_flag_follows_settings(store: InMemoryDeviceStore) -> None:
    insecure_app = create_app(settings=make_settings(cookie_secure=False), devices=store)
    await seed_code(store, "web")
    transport = ASGITransport(app=insecure_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        response = await pair(c, kind="web")
    attrs = cookie_attrs(response)
    assert "secure" not in attrs
    assert {"httponly", "samesite=strict", "path=/v1/auth"} <= attrs


async def test_refresh_with_cookie_alone_rotates_cookie(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "web")
    paired = await pair(client, kind="web")
    old_cookie = cookie_pair(paired)

    refreshed = await client.post("/v1/auth/refresh", headers={"Cookie": old_cookie})
    assert refreshed.status_code == 200
    body = refreshed.json()
    assert body["device_id"] == paired.json()["device_id"]
    assert body["refresh_token"] is None
    assert verify_access(body["access_token"], SECRET).kind == "web"
    new_cookie = cookie_pair(refreshed)
    assert new_cookie != old_cookie
    assert {"httponly", "secure", "samesite=strict", "path=/v1/auth"} <= cookie_attrs(refreshed)
    assert f"max-age={COOKIE_MAX_AGE}" in cookie_attrs(refreshed)

    # the old cookie is dead after rotation, the new one works
    replay = await client.post("/v1/auth/refresh", headers={"Cookie": old_cookie})
    assert replay.status_code == 401
    assert replay.json() == UNAUTHORIZED
    again = await client.post("/v1/auth/refresh", headers={"Cookie": new_cookie})
    assert again.status_code == 200


@pytest.mark.parametrize(
    "cookie",
    [
        "yawmi_rt=",
        "yawmi_rt=no-dot-here",
        "yawmi_rt=not-a-uuid.sometoken",
        f"yawmi_rt={uuid4()}.",
        f"yawmi_rt={uuid4()}.unknown-token-value",
        "other=1",
    ],
)
async def test_refresh_rejects_malformed_or_unknown_cookie(
    client: httpx.AsyncClient, cookie: str
) -> None:
    response = await client.post("/v1/auth/refresh", headers={"Cookie": cookie})
    assert response.status_code == 401
    assert response.json() == UNAUTHORIZED


# --- native: refresh token travels in the body -------------------------------------------------


async def test_refresh_with_body_rotates_token(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "iphone")
    paired = (await pair(client)).json()
    payload = {"device_id": paired["device_id"], "refresh_token": paired["refresh_token"]}

    refreshed = await client.post("/v1/auth/refresh", json=payload)
    assert refreshed.status_code == 200
    body = refreshed.json()
    assert body["device_id"] == paired["device_id"]
    assert body["refresh_token"] not in (None, paired["refresh_token"])
    assert verify_access(body["access_token"], SECRET).kind == "iphone"
    assert "set-cookie" not in refreshed.headers

    replay = await client.post("/v1/auth/refresh", json=payload)
    assert replay.status_code == 401
    assert replay.json() == UNAUTHORIZED
    chained = await client.post(
        "/v1/auth/refresh",
        json={"device_id": paired["device_id"], "refresh_token": body["refresh_token"]},
    )
    assert chained.status_code == 200


async def test_refresh_without_credentials_is_unauthorized(client: httpx.AsyncClient) -> None:
    response = await client.post("/v1/auth/refresh")
    assert response.status_code == 401
    assert response.json() == UNAUTHORIZED


async def test_refresh_with_wrong_token_or_unknown_device_is_unauthorized(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "iphone")
    paired = (await pair(client)).json()
    wrong = await client.post(
        "/v1/auth/refresh", json={"device_id": paired["device_id"], "refresh_token": "nope"}
    )
    unknown = await client.post(
        "/v1/auth/refresh",
        json={"device_id": str(uuid4()), "refresh_token": paired["refresh_token"]},
    )
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == UNAUTHORIZED


# --- revoke ------------------------------------------------------------------------------------


async def test_refresh_after_revoke_is_unauthorized(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "iphone")
    paired = (await pair(client)).json()
    revoked = await client.post(
        f"/v1/devices/{paired['device_id']}/revoke", headers=bearer(service_token())
    )
    assert revoked.status_code == 204
    device = await store.get_device(UUID(paired["device_id"]))
    assert device is not None
    assert device.revoked_at is not None

    response = await client.post(
        "/v1/auth/refresh",
        json={"device_id": paired["device_id"], "refresh_token": paired["refresh_token"]},
    )
    assert response.status_code == 401
    assert response.json() == UNAUTHORIZED


async def test_web_refresh_after_revoke_is_unauthorized(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    await seed_code(store, "web")
    paired = await pair(client, kind="web")
    await client.post(
        f"/v1/devices/{paired.json()['device_id']}/revoke", headers=bearer(service_token())
    )
    response = await client.post("/v1/auth/refresh", headers={"Cookie": cookie_pair(paired)})
    assert response.status_code == 401


async def test_revoke_requires_a_token(client: httpx.AsyncClient) -> None:
    response = await client.post(f"/v1/devices/{uuid4()}/revoke")
    assert response.status_code == 401
    assert response.json() == UNAUTHORIZED


@pytest.mark.parametrize("kind", ["iphone", "watch", "web"])
async def test_revoke_is_service_only(
    client: httpx.AsyncClient, store: InMemoryDeviceStore, kind: str
) -> None:
    await seed_code(store, kind)
    paired = (await pair(client, kind=kind)).json()
    token = issue_access(uuid4(), kind, SECRET, TTL)
    response = await client.post(f"/v1/devices/{paired['device_id']}/revoke", headers=bearer(token))
    assert response.status_code == 403
    assert response.json() == FORBIDDEN
    device = await store.get_device(UUID(paired["device_id"]))
    assert device is not None
    assert device.revoked_at is None


async def test_revoke_unknown_device_is_404_and_repeat_is_idempotent(
    client: httpx.AsyncClient, store: InMemoryDeviceStore
) -> None:
    unknown = await client.post(f"/v1/devices/{uuid4()}/revoke", headers=bearer(service_token()))
    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "الجهاز غير موجود"}

    await seed_code(store, "iphone")
    paired = (await pair(client)).json()
    url = f"/v1/devices/{paired['device_id']}/revoke"
    assert (await client.post(url, headers=bearer(service_token()))).status_code == 204
    assert (await client.post(url, headers=bearer(service_token()))).status_code == 204


# --- app factory and lifespan ------------------------------------------------------------------


def test_module_level_app_exists_and_import_needs_no_environment() -> None:
    assert module_app.title == "yawmi-api"
    assert module_app.state.use_db is True
    assert set(module_app.openapi()["paths"]) == {
        "/v1/health/live",
        "/v1/devices/pair",
        "/v1/auth/refresh",
        "/v1/devices/{device_id}/revoke",
    }


async def test_lifespan_leaves_the_database_alone_with_an_injected_store(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def forbidden_pool(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("the pool must not be created when a store is injected")

    monkeypatch.setattr("yawmi.main.create_pool", forbidden_pool)
    assert app.state.use_db is False
    async with app.router.lifespan_context(app):
        pass


class _FakePool:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


async def test_lifespan_opens_and_closes_the_pool_when_db_is_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _FakePool()
    seen: list[str] = []

    async def fake_create_pool(dsn: str, **_kwargs: object) -> _FakePool:
        seen.append(dsn)
        return pool

    monkeypatch.setattr("yawmi.main.create_pool", fake_create_pool)
    db_app = create_app(settings=make_settings())
    assert db_app.state.use_db is True
    async with db_app.router.lifespan_context(db_app):
        assert seen == ["postgresql://yawmi_api@localhost:5432/raqib"]
        assert get_pool() is pool
        assert isinstance(db_app.state.devices, AsyncpgDeviceStore)
    assert pool.closed
    with pytest.raises(RuntimeError):
        get_pool()
