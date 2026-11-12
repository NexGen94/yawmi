"""Shared pieces of the API tests that run on both the in-memory and the Postgres backend.

`open_backend` yields a backend of either kind (the Postgres one is skipped without
`TEST_DATABASE_URL`, and is a failure in CI), `build_app` and `http_client` make the app and a
client over it, and `auth_header` is a user device's bearer token.
"""

import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any
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
from yawmi.settings import Settings

SECRET = "test-secret-for-unit-tests-only-0123456789"
IN_CI = bool(os.environ.get("CI"))


def auth_header(device_id: UUID, kind: str = "web") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(device_id, kind, SECRET, 3600)}"}


@asynccontextmanager
async def open_pool() -> AsyncIterator[asyncpg.Pool]:
    """A pool on the test database, installed as the app's pool; skip or fail when there is none."""
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not")
        pytest.skip("TEST_DATABASE_URL is not set (database tests run in CI)")
    pool = await create_pool(url)
    set_pool(pool)
    try:
        yield pool
    finally:
        set_pool(None)
        await pool.close()


@asynccontextmanager
async def open_backend(
    kind: str, memory: Callable[[], Any], postgres: Callable[[asyncpg.Pool], Any]
) -> AsyncIterator[Any]:
    """A set-up backend of `kind` (`memory` or `postgres`), cleaned up afterwards."""
    if kind == "memory":
        backend = memory()
        await backend.setup()
        try:
            yield backend
        finally:
            await backend.cleanup()
        return
    async with open_pool() as pool:
        backend = postgres(pool)
        await backend.setup()
        try:
            yield backend
        finally:
            await backend.cleanup()


def build_app(install: Callable[[FastAPI], None]) -> FastAPI:
    settings = Settings(
        database_url="postgresql://yawmi_api@localhost:5432/raqib",
        jwt_secret=SecretStr(SECRET),
    )
    app = create_app(settings=settings, devices=InMemoryDeviceStore())
    install(app)
    return app


@asynccontextmanager
async def http_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
