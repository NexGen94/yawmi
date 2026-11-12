"""Goal tasks: `GET`/`POST /v1/goals/{ref}/tasks` and `PATCH /v1/goal-tasks/{task_id}`."""

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from api_harness import auth_header as bearer
from api_harness import build_app, http_client
from fastapi import FastAPI
from goals_harness import GoalsBackend

DEVICE = UUID("00000000-0000-7000-8000-000000000415")
SERVER_NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)  # the pinned clock of conftest.py


@pytest.fixture
def app(goals_backend: GoalsBackend) -> FastAPI:
    return build_app(goals_backend.install)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(app) as c:
        yield c


def auth(kind: str = "web") -> dict[str, str]:
    return bearer(DEVICE, kind)


async def add(client: httpx.AsyncClient, ref: str, title: str = "مهمة", **extra: Any) -> Any:
    return await client.post(
        f"/v1/goals/{ref}/tasks", json={"title": title, **extra}, headers=auth()
    )


async def items(client: httpx.AsyncClient, ref: str) -> list[dict[str, Any]]:
    resp = await client.get(f"/v1/goals/{ref}/tasks", headers=auth())
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]  # type: ignore[no-any-return]


async def test_a_task_for_an_unknown_reference_is_a_404(client: httpx.AsyncClient) -> None:
    for ref in ("t13_nothing", "O13", "O0", "o1"):
        assert (await add(client, ref)).status_code == 404, ref
        assert (await client.get(f"/v1/goals/{ref}/tasks", headers=auth())).status_code == 404


async def test_a_task_for_an_outcome_code_is_created_even_with_an_empty_mirror(
    client: httpx.AsyncClient,
) -> None:
    resp = await add(client, "O1", "حجز الاختبار", due_day="2026-12-01")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["goal_ref"], body["title"], body["due_day"]) == (
        "O1",
        "حجز الاختبار",
        "2026-12-01",
    )
    assert (body["done_at"], body["position"], body["archived"]) == (None, 0, False)
    UUID(body["id"])
    assert [t["id"] for t in await items(client, "O1")] == [body["id"]]


async def test_a_card_or_a_milestone_of_the_mirror_is_a_valid_reference(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    card = await goals_backend.card("c1")
    milestone = await goals_backend.milestone("m1", "O1")
    assert (await add(client, card)).status_code == 201
    assert (await add(client, milestone)).status_code == 201
    assert len(await items(client, card)) == 1 and await items(client, "O2") == []


async def test_tasks_keep_their_order_and_each_goal_has_its_own(client: httpx.AsyncClient) -> None:
    for title in ("أولى", "ثانية", "ثالثة"):
        await add(client, "O1", title)
    await add(client, "O2", "أخرى")
    first = await items(client, "O1")
    assert [t["title"] for t in first] == ["أولى", "ثانية", "ثالثة"]
    assert [t["position"] for t in first] == [0, 1, 2]
    assert [t["position"] for t in await items(client, "O2")] == [0]
    # a new position moves a task
    resp = await client.patch(
        f"/v1/goal-tasks/{first[0]['id']}", json={"position": 9}, headers=auth()
    )
    assert resp.json()["position"] == 9
    assert [t["title"] for t in await items(client, "O1")] == ["ثانية", "ثالثة", "أولى"]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"title": ""},
        {"title": "   "},
        {"title": "x" * 201},
        {"title": "a\u0000b"},
        {"title": "ok", "extra": 1},
        {"title": "ok", "due_day": "1999-01-01"},
        {"title": "ok", "due_day": "not a date"},
    ],
)
async def test_a_bad_task_is_a_422(client: httpx.AsyncClient, body: dict[str, Any]) -> None:
    resp = await client.post("/v1/goals/O1/tasks", json=body, headers=auth())
    assert resp.status_code == 422, resp.text
    assert await items(client, "O1") == []


async def test_done_fills_done_at_and_undone_clears_it(client: httpx.AsyncClient) -> None:
    task = (await add(client, "O1")).json()
    url = f"/v1/goal-tasks/{task['id']}"
    done = (await client.patch(url, json={"done": True}, headers=auth())).json()
    assert datetime.fromisoformat(done["done_at"]) == SERVER_NOW
    again = (await client.patch(url, json={"done": True}, headers=auth())).json()
    assert again["done_at"] == done["done_at"]  # idempotent
    undone = (await client.patch(url, json={"done": False}, headers=auth())).json()
    assert undone["done_at"] is None


async def test_title_and_due_day_are_edited_and_the_due_day_can_be_cleared(
    client: httpx.AsyncClient,
) -> None:
    task = (await add(client, "O1", "قديم", due_day="2026-12-01")).json()
    url = f"/v1/goal-tasks/{task['id']}"
    body = (await client.patch(url, json={"title": "جديد"}, headers=auth())).json()
    assert (body["title"], body["due_day"]) == ("جديد", "2026-12-01")
    body = (await client.patch(url, json={"due_day": "2026-12-15"}, headers=auth())).json()
    assert body["due_day"] == "2026-12-15"
    body = (await client.patch(url, json={"due_day": None}, headers=auth())).json()
    assert (body["due_day"], body["title"]) == (None, "جديد")


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"title": None},
        {"done": None},
        {"archived": None},
        {"position": None},
        {"done": "yes"},
        {"position": -1},
        {"unknown": 1},
    ],
)
async def test_a_bad_patch_is_a_422_and_changes_nothing(
    client: httpx.AsyncClient, body: dict[str, Any]
) -> None:
    task = (await add(client, "O1")).json()
    resp = await client.patch(f"/v1/goal-tasks/{task['id']}", json=body, headers=auth())
    assert resp.status_code == 422, resp.text
    assert (await items(client, "O1"))[0]["title"] == "مهمة"


async def test_an_unknown_task_is_a_404(client: httpx.AsyncClient) -> None:
    resp = await client.patch(f"/v1/goal-tasks/{uuid4()}", json={"done": True}, headers=auth())
    assert resp.status_code == 404
    assert (
        await client.patch("/v1/goal-tasks/not-a-uuid", json={"done": True}, headers=auth())
    ).status_code == 422


async def test_there_is_no_delete(client: httpx.AsyncClient) -> None:
    task = (await add(client, "O1")).json()
    resp = await client.delete(f"/v1/goal-tasks/{task['id']}", headers=auth())
    assert resp.status_code == 405
    assert len(await items(client, "O1")) == 1


async def test_an_archived_task_leaves_the_list_and_the_totals(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await goals_backend.outcome("O1")
    keep = (await add(client, "O1", "باقية")).json()
    gone = (await add(client, "O1", "مغلقة")).json()
    await client.patch(f"/v1/goal-tasks/{keep['id']}", json={"done": True}, headers=auth())
    await client.patch(f"/v1/goal-tasks/{gone['id']}", json={"archived": True}, headers=auth())
    assert [t["title"] for t in await items(client, "O1")] == ["باقية"]
    outcome = next(
        o
        for o in (await client.get("/v1/goals", headers=auth())).json()["outcomes"]
        if o["code"] == "O1"
    )
    ind = outcome["indicator"]
    assert (ind["source"], ind["value"], ind["target"], ind["completion"]) == ("tasks", 1, 1, 1.0)
    # the archive can be undone
    back = await client.patch(
        f"/v1/goal-tasks/{gone['id']}", json={"archived": False}, headers=auth()
    )
    assert back.json()["archived"] is False and len(await items(client, "O1")) == 2


async def test_an_older_event_does_not_override_a_direct_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    task = (await add(client, "O1")).json()
    task_id = UUID(task["id"])
    url = f"/v1/goal-tasks/{task['id']}"
    # a direct edit at the server's now (12:00 UTC) marks the task done
    await client.patch(url, json={"done": True}, headers=auth())
    # an event queued offline before it (11:00) does not undo it...
    await goals_backend.mark_from_event(task_id, False, datetime(2026, 11, 10, 11, 0, tzinfo=UTC))
    assert (await items(client, "O1"))[0]["done_at"] is not None
    # ...and one after it (13:00) does
    await goals_backend.mark_from_event(task_id, False, datetime(2026, 11, 10, 13, 0, tzinfo=UTC))
    assert (await items(client, "O1"))[0]["done_at"] is None
    # an older event cannot override a later direct un-done either
    await goals_backend.mark_from_event(task_id, True, datetime(2026, 11, 10, 12, 30, tzinfo=UTC))
    assert (await items(client, "O1"))[0]["done_at"] is None


async def test_the_task_routes_need_a_user_device(client: httpx.AsyncClient) -> None:
    assert (await client.get("/v1/goals/O1/tasks")).status_code == 401
    resp = await client.post("/v1/goals/O1/tasks", json={"title": "x"}, headers=auth("service"))
    assert resp.status_code == 403
    assert (await client.patch(f"/v1/goal-tasks/{uuid4()}", json={"done": True})).status_code == 401
