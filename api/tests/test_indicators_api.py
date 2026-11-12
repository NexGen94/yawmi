"""Tests for `GET`, `PUT`, and `DELETE` `/v1/indicators` (memory and Postgres backends)."""

import json
import os
import urllib.parse
from collections.abc import AsyncIterator
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
from yawmi.indicators.memory import InMemoryIndicatorStore
from yawmi.indicators.models import IndicatorIO
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
    indicators: Any

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


def goal_body(**over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "subject_kind": "goal",
        "subject_ref": "O1",
        "source": "tasks",
        "measure": "completion",
        "period": "cycle",
        "display": "bar",
    }
    return body | over


def habit_body(**over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "subject_kind": "habit",
        "subject_ref": "read",
        "source": "habit_logs",
        "measure": "strength",
        "period": "week",
        "display": "ring",
    }
    return body | over


def raw_json(headers: dict[str, str] | None = None) -> dict[str, str]:
    return (headers or auth_header()) | {"Content-Type": "application/json"}


async def test_the_subject_is_the_urls_and_a_mismatching_body_is_a_422_that_stores_nothing(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    # a habit body sent to a goal URL, and a goal body (with a reminder) sent to a habit URL
    for url, body in (
        ("/v1/indicators/goal/O1", habit_body()),
        ("/v1/indicators/habit/read", goal_body(reminder={"time": "20:00", "days_mask": 127})),
        ("/v1/indicators/goal/O1", goal_body(subject_ref="O2")),
        ("/v1/indicators/goal/O1", goal_body(subject_kind="habit", source="habit_logs")),
    ):
        resp = await client.put(url, json=body, headers=auth_header())
        assert resp.status_code == 422, (url, resp.text)
    assert await backend.indicators.list() == []


async def test_a_body_without_the_subject_is_a_422(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    body = goal_body()
    del body["subject_kind"]
    resp = await client.put("/v1/indicators/goal/O1", json=body, headers=auth_header())
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize(
    "over",
    [
        {"title_ar": "عنوان\x00خبيث"},
        {"title_ar": "أ" * 5000},
        {"title_ar": "أ" * 81},
        {"title_ar": "   "},
        {"title_ar": ""},
        {"target": 0},
        {"target": -1},
        {"target": float("inf")},
        {"target": 1e12},
    ],
)
async def test_the_new_text_and_number_fields_are_validated(
    client: httpx.AsyncClient, backend: Backend, over: dict[str, Any]
) -> None:
    resp = await client.put(
        "/v1/indicators/goal/O1", content=json.dumps(goal_body(**over)).encode(), headers=raw_json()
    )
    assert resp.status_code == 422, resp.text
    assert await backend.indicators.list() == []


async def test_a_lone_surrogate_in_the_title_is_a_422(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    raw = json.dumps(goal_body())[:-1] + ', "title_ar": "' + "\\" + 'ud800"}'
    resp = await client.put("/v1/indicators/goal/O1", content=raw.encode(), headers=raw_json())
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize("ref", ["%20", "%20%20", "%00", "a%00b", "x" * 129])
async def test_a_blank_nul_or_long_subject_ref_is_a_422_on_every_verb(
    client: httpx.AsyncClient, backend: Backend, ref: str
) -> None:
    decoded = urllib.parse.unquote(ref)
    put = await client.put(
        f"/v1/indicators/goal/{ref}", json=goal_body(subject_ref=decoded), headers=auth_header()
    )
    assert put.status_code == 422, put.text
    delete = await client.delete(f"/v1/indicators/goal/{ref}", headers=auth_header())
    assert delete.status_code == 422, delete.text
    assert await backend.indicators.list() == []


async def test_the_id_is_the_servers_and_stays_when_the_indicator_is_replaced(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    first = await client.put(
        "/v1/indicators/goal/O1",
        json=goal_body(id=str(uuid4()), updated_at="2001-01-01T00:00:00Z"),
        headers=auth_header(),
    )
    assert first.status_code == 200, first.text
    second = await client.put(
        "/v1/indicators/goal/O1", json=goal_body(title_ar="ثانٍ"), headers=auth_header()
    )
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["updated_at"] >= first.json()["updated_at"]
    assert not second.json()["updated_at"].startswith("2001")


async def test_the_store_lists_puts_and_deletes_by_the_registry_names(backend: Backend) -> None:
    saved = await backend.indicators.put(IndicatorIO(**goal_body()))
    assert (saved.subject_kind, saved.subject_ref) == ("goal", "O1")
    assert [i.subject_ref for i in await backend.indicators.list()] == ["O1"]
    assert await backend.indicators.delete("goal", "O1") is True
    assert await backend.indicators.delete("goal", "O1") is False
    assert await backend.indicators.list() == []


async def test_the_put_body_is_the_one_indicator_schema(
    client: httpx.AsyncClient, backend: Backend, app: FastAPI
) -> None:
    spec = app.openapi()
    schemas = spec["components"]["schemas"]
    assert "IndicatorIn" not in schemas
    put = spec["paths"]["/v1/indicators/{subject_kind}/{subject_ref}"]["put"]
    body = put["requestBody"]["content"]["application/json"]["schema"]
    assert body == {"$ref": "#/components/schemas/IndicatorIO"}
    # one schema serves as request and response: no `-Input` / `-Output` pair
    assert not [name for name in schemas if name.startswith("IndicatorIO-")]
