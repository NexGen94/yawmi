"""The Notion port for an outside applier: `GET /v1/notion/changes` and
`POST /v1/notion/changes/{change_id}/result`, with the service token only (design §7.1, §11)."""

from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from api_harness import auth_header as bearer
from api_harness import build_app, http_client
from fastapi import FastAPI
from goals_harness import GoalsBackend

DEVICE = UUID("00000000-0000-7000-8000-000000000614")
SERVICE = UUID("00000000-0000-7000-8000-000000000615")
SERVER_NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)  # the pinned clock of conftest.py


@pytest.fixture
def app(goals_backend: GoalsBackend) -> FastAPI:
    return build_app(goals_backend.install)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(app) as c:
        yield c


def web() -> dict[str, str]:
    return bearer(DEVICE, "web")


def service() -> dict[str, str]:
    return bearer(SERVICE, "service")


async def two_edits(client: httpx.AsyncClient, backend: GoalsBackend) -> tuple[str, str]:
    await backend.outcome("O1")
    first = await backend.milestone("m1", "O1", due=date(2026, 11, 7))
    second = await backend.milestone("m2", "O1", due=date(2026, 12, 1))
    for page, body in ((first, {"due_date": "2026-11-14"}), (second, {"done": True})):
        resp = await client.patch(f"/v1/milestones/{page}", json=body, headers=web())
        assert resp.status_code == 200, resp.text
    return first, second


async def changes(client: httpx.AsyncClient, **params: Any) -> list[dict[str, Any]]:
    resp = await client.get("/v1/notion/changes", params=params, headers=service())
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]  # type: ignore[no-any-return]


async def result(client: httpx.AsyncClient, change_id: str, **body: Any) -> httpx.Response:
    return await client.post(
        f"/v1/notion/changes/{change_id}/result", json=body, headers=service()
    )


async def log(client: httpx.AsyncClient) -> dict[str, dict[str, Any]]:
    resp = await client.get("/v1/goal-edits", headers=web())
    assert resp.status_code == 200
    return {r["id"]: r for r in resp.json()["items"]}


async def test_a_device_token_is_refused_on_both_routes(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    for kind in ("web", "iphone", "watch"):
        headers = bearer(DEVICE, kind)
        assert (await client.get("/v1/notion/changes", headers=headers)).status_code == 403
        resp = await client.post(
            f"/v1/notion/changes/{uuid4()}/result", json={"ok": True}, headers=headers
        )
        assert resp.status_code == 403
    assert (await client.get("/v1/notion/changes")).status_code == 401


async def test_the_service_reads_the_pending_changes_in_creation_order(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    await goals_backend.outcome("O1")
    first = await goals_backend.milestone("m1", "O1", due=date(2026, 11, 7))
    second = await goals_backend.milestone("m2", "O1", due=date(2026, 12, 1))
    for i, (page, body) in enumerate(((second, {"done": True}), (first, {"due_date": "2026-11-14"}))):
        at = datetime(2026, 11, 10, 12, i, tzinfo=UTC)
        monkeypatch.setattr("yawmi.events.models.server_now", lambda at=at: at)
        resp = await client.patch(f"/v1/milestones/{page}", json=body, headers=web())
        assert resp.status_code == 200
    items = await changes(client)
    assert [(c["page_id"], c["field"]) for c in items] == [(second, "done"), (first, "due_date")]
    assert set(items[0]) == {
        "id",
        "target_kind",
        "page_id",
        "field",
        "old_value",
        "new_value",
        "note",
    }
    assert (items[0]["old_value"], items[0]["new_value"]) == (False, True)
    assert (items[1]["old_value"], items[1]["new_value"]) == ("2026-11-07", "2026-11-14")
    assert [c["page_id"] for c in await changes(client, limit=1)] == [second]
    bad = await client.get("/v1/notion/changes", params={"limit": 0}, headers=service())
    assert bad.status_code == 422


async def test_an_ok_result_applies_the_change(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await two_edits(client, goals_backend)
    first = (await changes(client))[0]
    resp = await result(client, first["id"], ok=True)
    assert resp.status_code == 204, resp.text
    row = (await log(client))[first["id"]]
    assert (row["status"], row["applied_at"], row["error"]) == (
        "applied",
        SERVER_NOW.isoformat().replace("+00:00", "Z"),
        None,
    )
    remaining = [c["id"] for c in await changes(client)]
    assert len(remaining) == 1 and first["id"] not in remaining


async def test_a_conflict_result_and_a_failure_result(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await two_edits(client, goals_backend)
    first, second = await changes(client)
    assert (await result(client, first["id"], ok=False, conflict=True)).status_code == 204
    assert (await result(client, second["id"], ok=False, error="انتهت المهلة")).status_code == 204
    rows = await log(client)
    assert (rows[first["id"]]["status"], rows[first["id"]]["applied_at"]) == ("conflict", None)
    assert (rows[second["id"]]["status"], rows[second["id"]]["error"]) == (
        "failed",
        "انتهت المهلة",
    )
    assert await changes(client) == []


async def test_an_unknown_change_is_a_404_and_a_finished_one_a_409(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await two_edits(client, goals_backend)
    assert (await result(client, str(uuid4()), ok=True)).status_code == 404
    first = (await changes(client))[0]
    assert (await result(client, first["id"], ok=True)).status_code == 204
    assert (await result(client, first["id"], ok=True)).status_code == 409
    assert (await result(client, first["id"], ok=False, conflict=True)).status_code == 409


async def test_a_result_body_is_checked(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await two_edits(client, goals_backend)
    first = (await changes(client))[0]
    for body in (
        {},
        {"ok": "yes"},
        {"ok": True, "conflict": True},
        {"ok": False, "error": "x" * 501},
        {"ok": True, "extra": 1},
    ):
        resp = await client.post(
            f"/v1/notion/changes/{first['id']}/result", json=body, headers=service()
        )
        assert resp.status_code == 422, body
    assert (await log(client))[first["id"]]["status"] == "pending"
