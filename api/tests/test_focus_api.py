"""`/v1/focus/plans` and `GET /v1/focus/sessions` on both backends (design §7.1, §7.5)."""

from typing import Any

import httpx
import pytest
from focus_harness import Backend, auth, event, post_events

PLANS = "/v1/focus/plans"
SESSIONS = "/v1/focus/sessions"


def plan(**over: Any) -> dict[str, Any]:
    return {"title_ar": "كتابة الفصل", "minutes": 25, "favorite": False, "active": True, **over}


async def create(focus_client: httpx.AsyncClient, **over: Any) -> dict[str, Any]:
    resp = await focus_client.post(PLANS, json=plan(**over), headers=auth())
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.parametrize("path", [PLANS, SESSIONS, "/v1/breath/sessions"])
async def test_every_route_needs_a_device_token(focus_client: httpx.AsyncClient, path: str) -> None:
    params = {"from": "2026-11-10", "to": "2026-11-10"}
    assert (await focus_client.get(path, params=params)).status_code == 401
    assert (await focus_client.get(path, params=params, headers=auth("service"))).status_code == 403


@pytest.mark.parametrize("minutes", [4, 241, 0, -5])
async def test_minutes_outside_five_to_240_is_a_422(
    focus_client: httpx.AsyncClient, minutes: int
) -> None:
    resp = await focus_client.post(PLANS, json=plan(minutes=minutes), headers=auth())
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize("minutes", [5, 240])
async def test_the_limits_of_minutes_are_accepted(
    focus_client: httpx.AsyncClient, minutes: int
) -> None:
    assert (await create(focus_client, minutes=minutes))["minutes"] == minutes


async def test_a_weekday_mask_without_a_start_time_is_a_422_and_the_reverse(
    focus_client: httpx.AsyncClient,
) -> None:
    only_mask = await focus_client.post(PLANS, json=plan(weekday_mask=2), headers=auth())
    only_time = await focus_client.post(PLANS, json=plan(start_time="09:00"), headers=auth())
    assert only_mask.status_code == 422, only_mask.text
    assert only_time.status_code == 422, only_time.text
    both = await create(focus_client, weekday_mask=2, start_time="09:00")
    assert (both["weekday_mask"], both["start_time"]) == (2, "09:00")


@pytest.mark.parametrize(
    "bad",
    [
        {"weekday_mask": 0, "start_time": "09:00"},
        {"weekday_mask": 128, "start_time": "09:00"},
        {"weekday_mask": 2, "start_time": "9:00"},
        {"weekday_mask": 2, "start_time": "24:00"},
        {"title_ar": ""},
        {"title_ar": "ن" * 81},
        {"unknown_field": 1},
    ],
)
async def test_bad_plan_bodies_are_422(
    focus_client: httpx.AsyncClient, bad: dict[str, Any]
) -> None:
    resp = await focus_client.post(PLANS, json=plan(**bad), headers=auth())
    assert resp.status_code == 422, resp.text


async def test_a_plan_is_created_listed_and_carries_its_id_and_time(
    focus_client: httpx.AsyncClient,
) -> None:
    made = await create(focus_client, goal_ref="O7", favorite=True)
    assert made["id"] and made["updated_at"]
    assert made["title_ar"] == "كتابة الفصل" and made["goal_ref"] == "O7"
    listed = await focus_client.get(PLANS, headers=auth())
    assert listed.status_code == 200
    assert listed.json() == {"items": [made]}


async def test_the_favorites_come_first(focus_client: httpx.AsyncClient) -> None:
    plain = await create(focus_client, title_ar="عادية")
    star = await create(focus_client, title_ar="مفضلة", favorite=True)
    items = (await focus_client.get(PLANS, headers=auth())).json()["items"]
    assert [p["id"] for p in items] == [star["id"], plain["id"]]


async def test_a_plan_can_name_a_known_habit_and_not_an_unknown_one(
    focus_client: httpx.AsyncClient, focus_backend: Backend
) -> None:
    code = await focus_backend.new_habit()
    assert (await create(focus_client, habit_code=code))["habit_code"] == code
    unknown = await focus_client.post(PLANS, json=plan(habit_code="t22-nope"), headers=auth())
    assert unknown.status_code == 422, unknown.text
    assert unknown.json()["errors"][0]["type"] == "unknown_habit"


async def test_patch_changes_only_the_sent_fields(focus_client: httpx.AsyncClient) -> None:
    made = await create(focus_client, goal_ref="O7")
    resp = await focus_client.patch(
        f"{PLANS}/{made['id']}", json={"minutes": 50, "favorite": True}, headers=auth()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["minutes"], body["favorite"]) == (50, True)
    assert (body["title_ar"], body["goal_ref"], body["id"]) == ("كتابة الفصل", "O7", made["id"])
    assert body["updated_at"] >= made["updated_at"]


async def test_patch_can_clear_the_goal_and_the_schedule_together(
    focus_client: httpx.AsyncClient,
) -> None:
    made = await create(focus_client, goal_ref="O7", weekday_mask=2, start_time="09:00")
    cleared = await focus_client.patch(
        f"{PLANS}/{made['id']}",
        json={"goal_ref": None, "weekday_mask": None, "start_time": None},
        headers=auth(),
    )
    assert cleared.status_code == 200, cleared.text
    body = cleared.json()
    assert body["goal_ref"] is None and body["weekday_mask"] is None and body["start_time"] is None


async def test_patch_that_leaves_half_a_schedule_is_a_422_and_changes_nothing(
    focus_client: httpx.AsyncClient,
) -> None:
    made = await create(focus_client, weekday_mask=2, start_time="09:00")
    half = await focus_client.patch(
        f"{PLANS}/{made['id']}", json={"start_time": None}, headers=auth()
    )
    assert half.status_code == 422, half.text
    plain = await create(focus_client, title_ar="بلا جدول")
    other = await focus_client.patch(
        f"{PLANS}/{plain['id']}", json={"weekday_mask": 4}, headers=auth()
    )
    assert other.status_code == 422, other.text
    items = (await focus_client.get(PLANS, headers=auth())).json()["items"]
    by_id = {p["id"]: p for p in items}
    assert by_id[made["id"]]["start_time"] == "09:00"
    assert by_id[plain["id"]]["weekday_mask"] is None


@pytest.mark.parametrize("body", [{"minutes": 4}, {"title_ar": None}, {"minutes": None}, {"x": 1}])
async def test_a_bad_patch_is_a_422(focus_client: httpx.AsyncClient, body: dict[str, Any]) -> None:
    made = await create(focus_client)
    resp = await focus_client.patch(f"{PLANS}/{made['id']}", json=body, headers=auth())
    assert resp.status_code == 422, resp.text


async def test_an_empty_patch_is_a_422(focus_client: httpx.AsyncClient) -> None:
    made = await create(focus_client)
    resp = await focus_client.patch(f"{PLANS}/{made['id']}", json={}, headers=auth())
    assert resp.status_code == 422, resp.text
    assert resp.json()["errors"][0]["type"] == "empty_patch"


async def test_patching_an_unknown_plan_is_a_404(focus_client: httpx.AsyncClient) -> None:
    resp = await focus_client.patch(
        f"{PLANS}/00000000-0000-4000-8000-000000000001", json={"minutes": 30}, headers=auth()
    )
    assert resp.status_code == 404, resp.text


async def test_deactivating_hides_a_plan_by_default_and_all_shows_it(
    focus_client: httpx.AsyncClient,
) -> None:
    made = await create(focus_client)
    resp = await focus_client.patch(f"{PLANS}/{made['id']}", json={"active": False}, headers=auth())
    assert resp.status_code == 200 and resp.json()["active"] is False
    assert (await focus_client.get(PLANS, headers=auth())).json() == {"items": []}
    shown = await focus_client.get(PLANS, params={"all": "true"}, headers=auth())
    assert [p["id"] for p in shown.json()["items"]] == [made["id"]]
    back = await focus_client.patch(f"{PLANS}/{made['id']}", json={"active": True}, headers=auth())
    assert back.status_code == 200
    assert len((await focus_client.get(PLANS, headers=auth())).json()["items"]) == 1


async def test_a_plan_cannot_be_deleted(focus_client: httpx.AsyncClient) -> None:
    made = await create(focus_client)
    resp = await focus_client.delete(f"{PLANS}/{made['id']}", headers=auth())
    assert resp.status_code == 405, resp.text
    kept = await focus_client.get(PLANS, params={"all": "true"}, headers=auth())
    assert len(kept.json()["items"]) == 1


async def test_a_focus_ended_event_comes_back_from_the_sessions_list(
    focus_client: httpx.AsyncClient,
) -> None:
    ev = event(
        "focus_ended",
        {
            "planned_minutes": 25,
            "actual_minutes": 31,
            "goal_ref": "O7",
            "focus_rating": 4,
            "next_step": "مراجعة الفقرة الثانية",
        },
    )
    await post_events(focus_client, ev)
    resp = await focus_client.get(
        SESSIONS, params={"from": "2026-11-10", "to": "2026-11-10"}, headers=auth()
    )
    assert resp.status_code == 200, resp.text
    [row] = resp.json()["items"]
    assert row["id"] == ev["id"]
    assert row["day"] == "2026-11-10"
    assert (row["planned_minutes"], row["actual_minutes"]) == (25, 31)
    assert (row["goal_ref"], row["habit_code"]) == ("O7", None)
    assert (row["focus_rating"], row["next_step"]) == (4, "مراجعة الفقرة الثانية")
    assert row["started_at"] and row["ended_at"]


async def test_sessions_are_filtered_by_day_and_ordered_by_start(
    focus_client: httpx.AsyncClient,
) -> None:
    late = event("focus_ended", {"actual_minutes": 10}, at="2026-11-10T09:00:00Z")
    early = event("focus_ended", {"actual_minutes": 20}, at="2026-11-10T05:00:00Z")
    other = event("focus_ended", {"actual_minutes": 30}, at="2026-11-09T05:00:00Z")
    await post_events(focus_client, late, early, other)
    resp = await focus_client.get(
        SESSIONS, params={"from": "2026-11-10", "to": "2026-11-11"}, headers=auth()
    )
    assert [r["id"] for r in resp.json()["items"]] == [early["id"], late["id"]]


async def test_the_range_of_400_days_is_accepted_and_401_is_a_422(
    focus_client: httpx.AsyncClient,
) -> None:
    ok = await focus_client.get(
        SESSIONS, params={"from": "2026-01-01", "to": "2027-02-04"}, headers=auth()
    )
    assert ok.status_code == 200, ok.text  # 400 days inclusive
    too_wide = await focus_client.get(
        SESSIONS, params={"from": "2026-01-01", "to": "2027-02-05"}, headers=auth()
    )
    assert too_wide.status_code == 422, too_wide.text
    assert too_wide.json()["errors"][0]["type"] == "range_too_large"
    backwards = await focus_client.get(
        SESSIONS, params={"from": "2026-11-10", "to": "2026-11-09"}, headers=auth()
    )
    assert backwards.status_code == 422
