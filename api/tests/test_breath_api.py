"""`breath_ended` with the post-session feeling and `GET /v1/breath/sessions` (design §7.5)."""

from typing import Any

import httpx
import pytest
from focus_harness import auth, event, post_events

BREATH = "/v1/breath/sessions"
DAY = {"from": "2026-11-10", "to": "2026-11-10"}


async def only_row(focus_client: httpx.AsyncClient) -> dict[str, Any]:
    resp = await focus_client.get(BREATH, params=DAY, headers=auth())
    assert resp.status_code == 200, resp.text
    [row] = resp.json()["items"]
    return row


async def test_a_breath_ended_event_comes_back_with_its_feeling(
    focus_client: httpx.AsyncClient,
) -> None:
    ev = event(
        "breath_ended",
        {"pattern": "calm", "duration_seconds": 300, "feeling": "calmer", "breaths_per_min": 6},
    )
    await post_events(focus_client, ev)
    row = await only_row(focus_client)
    assert row["id"] == ev["id"] and row["day"] == "2026-11-10"
    assert (row["pattern"], row["duration_seconds"], row["feeling"]) == ("calm", 300, "calmer")
    assert row["breaths_per_min"] == 6 and row["completed"] is True
    assert row["started_at"] and row["ended_at"]


@pytest.mark.parametrize("feeling", ["calmer", "same", "tense"])
async def test_every_feeling_of_the_closed_set_is_accepted(
    focus_client: httpx.AsyncClient, feeling: str
) -> None:
    await post_events(focus_client, event("breath_ended", {"pattern": "calm", "feeling": feeling}))
    assert (await only_row(focus_client))["feeling"] == feeling


@pytest.mark.parametrize("feeling", ["great", "", "Calmer", 3])
async def test_a_feeling_outside_the_set_is_refused(
    focus_client: httpx.AsyncClient, feeling: Any
) -> None:
    ev = event("breath_ended", {"pattern": "calm", "feeling": feeling})
    resp = await focus_client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert resp.status_code == 422, resp.text
    assert (await focus_client.get(BREATH, params=DAY, headers=auth())).json() == {"items": []}


async def test_a_session_without_a_feeling_reads_null(focus_client: httpx.AsyncClient) -> None:
    await post_events(focus_client, event("breath_ended", {"pattern": "box"}))
    row = await only_row(focus_client)
    assert row["pattern"] == "box" and row["feeling"] is None


async def test_the_pattern_stays_free_text_so_the_existing_patterns_still_pass(
    focus_client: httpx.AsyncClient,
) -> None:
    await post_events(focus_client, event("breath_ended", {"pattern": "box"}))
    await post_events(
        focus_client, event("breath_ended", {"pattern": "4-7-8"}, at="2026-11-10T07:00:00Z")
    )
    resp = await focus_client.get(BREATH, params=DAY, headers=auth())
    assert [r["pattern"] for r in resp.json()["items"]] == ["box", "4-7-8"]
    too_long = event("breath_ended", {"pattern": "x" * 65})
    refused = await focus_client.post("/v1/events", json={"events": [too_long]}, headers=auth())
    assert refused.status_code == 422


async def test_the_hold_test_and_the_exhale_test_come_back_in_the_list(
    focus_client: httpx.AsyncClient,
) -> None:
    hold = event(
        "breath_ended", {"pattern": "hold_test", "duration_seconds": 24}, at="2026-11-10T05:00:00Z"
    )
    exhale = event(
        "breath_ended",
        {"pattern": "exhale_test", "duration_seconds": 18},
        at="2026-11-10T06:00:00Z",
    )
    await post_events(focus_client, hold, exhale)
    resp = await focus_client.get(BREATH, params=DAY, headers=auth())
    rows = {r["pattern"]: r for r in resp.json()["items"]}
    assert rows["hold_test"]["duration_seconds"] == 24
    assert rows["exhale_test"]["duration_seconds"] == 18


async def test_breath_sessions_are_ordered_and_bounded_like_the_other_reads(
    focus_client: httpx.AsyncClient,
) -> None:
    late = event("breath_ended", {"pattern": "calm"}, at="2026-11-10T09:00:00Z")
    early = event("breath_ended", {"pattern": "box"}, at="2026-11-10T05:00:00Z")
    await post_events(focus_client, late, early)
    resp = await focus_client.get(BREATH, params=DAY, headers=auth())
    assert [r["id"] for r in resp.json()["items"]] == [early["id"], late["id"]]
    wide = await focus_client.get(
        BREATH, params={"from": "2026-01-01", "to": "2027-02-05"}, headers=auth()
    )
    assert wide.status_code == 422
    assert wide.json()["errors"][0]["type"] == "range_too_large"


@pytest.mark.parametrize(
    "payload",
    [
        {"pattern": "hold_test", "duration_seconds": 31},
        {"pattern": "hold_test", "duration_seconds": 600},
        {"pattern": "exhale_test", "duration_seconds": 61},
        {"pattern": "calm", "breaths_per_min": 20},
    ],
)
async def test_over_limit_breath_events_are_refused_with_a_code_and_store_nothing(
    focus_client: httpx.AsyncClient, payload: dict[str, Any]
) -> None:
    ev = event("breath_ended", payload)
    resp = await focus_client.post("/v1/events", json={"events": [ev]}, headers=auth())
    assert resp.status_code == 422, resp.text
    assert resp.json()["errors"][0]["type"] == "breath_limit"
    assert (await focus_client.get(BREATH, params=DAY, headers=auth())).json() == {"items": []}


async def test_the_limits_themselves_are_accepted(focus_client: httpx.AsyncClient) -> None:
    await post_events(
        focus_client,
        event("breath_ended", {"pattern": "hold_test", "duration_seconds": 30}),
        event("breath_ended", {"pattern": "exhale_test", "duration_seconds": 60}),
        event("breath_ended", {"pattern": "calm", "breaths_per_min": 6.5}),
        event("breath_ended", {"pattern": "box", "breaths_per_min": 20}),
    )
    resp = await focus_client.get(BREATH, params=DAY, headers=auth())
    assert len(resp.json()["items"]) == 4
