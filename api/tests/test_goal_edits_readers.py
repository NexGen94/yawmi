"""One source for every number (fix round 1, I-1 and M-1): every reader of milestones and cards
sees the goal edits laid over the mirror, as `GET /v1/goals` does.

The late notice, the milestone pace, `/v1/today` and `/v1/overview`: a milestone closed or moved
by a pending or an applied edit is late nowhere and counts as done everywhere. Each reader is
tested with a pending edit and with an applied one, on the in-memory stores and on Postgres.
"""

from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import httpx
import pytest
from api_harness import auth_header as bearer
from api_harness import build_app, http_client
from fastapi import FastAPI
from goals_harness import GoalsBackend

from yawmi.domain.periods import WeekStart
from yawmi.push.notices import _late_titles

DEVICE = UUID("00000000-0000-7000-8000-000000000714")
NOW = datetime(2026, 11, 11, 8, 0, tzinfo=UTC)  # 2026-11-11 in Riyadh
TODAY = date(2026, 11, 11)
APPLIED_AT = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)
WEEK_START: WeekStart = "sun"
STATES = ["pending", "applied"]


@pytest.fixture
def app(goals_backend: GoalsBackend, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setattr("yawmi.events.models.server_now", lambda: NOW)
    return build_app(goals_backend.install)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(app) as c:
        yield c


async def get(client: httpx.AsyncClient, path: str) -> Any:
    resp = await client.get(path, headers=bearer(DEVICE, "web"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def late_milestone(backend: GoalsBackend) -> str:
    """Outcome O1 with one open milestone due 2026-11-07 (late on the 11th), in cycle 1."""
    await backend.pause_other_habits()
    await backend.outcome("O1")
    await backend.cycle(1, date(2026, 10, 31), date(2026, 12, 31), date(2027, 1, 7))
    return await backend.milestone("m1", "O1", title="فحص الدم", due=date(2026, 11, 7), cycle=1)


async def close(backend: GoalsBackend, page: str, state: str) -> None:
    applied = APPLIED_AT if state == "applied" else None
    await backend.edit("milestone", page, "done", False, True, applied_at=applied)


async def move(backend: GoalsBackend, page: str, state: str) -> None:
    applied = APPLIED_AT if state == "applied" else None
    await backend.edit(
        "milestone", page, "due_date", date(2026, 11, 7), date(2026, 12, 1), applied_at=applied
    )


# --- the daily late notice ---------------------------------------------------------------------


async def test_without_an_edit_the_milestone_is_late(goals_backend: GoalsBackend) -> None:
    await late_milestone(goals_backend)
    assert await _late_titles(goals_backend.sources(), TODAY, WEEK_START) == ["فحص الدم"]


@pytest.mark.parametrize("state", STATES)
async def test_a_milestone_closed_by_an_edit_is_not_late(
    goals_backend: GoalsBackend, state: str
) -> None:
    page = await late_milestone(goals_backend)
    await close(goals_backend, page, state)
    assert await _late_titles(goals_backend.sources(), TODAY, WEEK_START) == []


@pytest.mark.parametrize("state", STATES)
async def test_a_milestone_moved_later_by_an_edit_is_not_late(
    goals_backend: GoalsBackend, state: str
) -> None:
    page = await late_milestone(goals_backend)
    await move(goals_backend, page, state)
    assert await _late_titles(goals_backend.sources(), TODAY, WEEK_START) == []


# --- the milestone pace ------------------------------------------------------------------------


async def test_the_pace_counts_the_mirror_without_an_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await late_milestone(goals_backend)
    pace = await get(client, "/v1/goals/O1/pace")
    assert (pace["basis"], pace["current_value"], pace["target_value"]) == ("milestones", 0.0, 1.0)


@pytest.mark.parametrize("state", STATES)
async def test_the_pace_counts_a_milestone_closed_by_an_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, state: str
) -> None:
    page = await late_milestone(goals_backend)
    await close(goals_backend, page, state)
    pace = await get(client, "/v1/goals/O1/pace")
    assert (pace["current_value"], pace["target_value"]) == (1.0, 1.0)


# --- /v1/today and /v1/overview ----------------------------------------------------------------


async def test_today_and_overview_show_the_mirror_without_an_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await late_milestone(goals_backend)
    assert (await get(client, "/v1/today"))["plan"]["focus_outcomes"] == ["O1"]
    [o1] = (await get(client, "/v1/overview"))["outcomes"]
    assert (o1["milestones_done"], o1["completion"]) == (0, 0.0)
    assert o1["next_milestone"]["page_id"] == page
    assert o1["next_milestone"]["due_date"] == "2026-11-07"


@pytest.mark.parametrize("state", STATES)
async def test_today_and_overview_count_a_milestone_closed_by_an_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, state: str
) -> None:
    page = await late_milestone(goals_backend)
    await close(goals_backend, page, state)
    assert (await get(client, "/v1/today"))["plan"]["focus_outcomes"] == []
    [o1] = (await get(client, "/v1/overview"))["outcomes"]
    assert (o1["milestones_done"], o1["completion"], o1["next_milestone"]) == (1, 1.0, None)


@pytest.mark.parametrize("state", STATES)
async def test_overview_shows_a_milestone_moved_by_an_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, state: str
) -> None:
    page = await late_milestone(goals_backend)
    await move(goals_backend, page, state)
    [o1] = (await get(client, "/v1/overview"))["outcomes"]
    assert o1["next_milestone"]["page_id"] == page
    assert o1["next_milestone"]["due_date"] == "2026-12-01"


@pytest.mark.parametrize("state", STATES)
async def test_overview_shows_a_card_status_set_by_an_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, state: str
) -> None:
    card = await goals_backend.card("c1", status="قيد التنفيذ", outcomes=["O1"])
    await goals_backend.card("c2", status="مكتملة")
    applied = APPLIED_AT if state == "applied" else None
    await goals_backend.edit("card", card, "status", "قيد التنفيذ", "مكتملة", applied_at=applied)
    cards = {c["page_id"]: c for c in (await get(client, "/v1/overview"))["cards"]}
    assert cards[card]["status"] == "مكتملة"
