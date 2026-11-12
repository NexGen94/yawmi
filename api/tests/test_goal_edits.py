"""Goal edits over the Notion mirror (design §11, rulings 7 and R-3).

`PATCH /v1/milestones/{page_id}` and `PATCH /v1/cards/{page_id}` write a pending row in
`yawmi.goal_edits`, never the mirror; `GET /v1/goals` lays the edits over the mirror; and
`apply_pending` hands them to an applier that refuses on a live mismatch. Every test runs on the
in-memory stores and on Postgres.
"""

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

from yawmi.notion.apply import ApplySummary, apply_pending
from yawmi.notion.changes import EDITABLE
from yawmi.notion.fake import FakeNotionApplier

DEVICE = UUID("00000000-0000-7000-8000-000000000514")
EDIT_TIME = datetime(2026, 11, 11, 8, 0, tzinfo=UTC)  # 11:00 in Riyadh, on 2026-11-11
APPLIED_AT = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)
NOTE_0714 = "2026-11-11 · يومي: الموعد من «2026-11-07» إلى «2026-11-14»"


class Clock:
    def __init__(self) -> None:
        self.now = EDIT_TIME

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    holder = Clock()
    monkeypatch.setattr("yawmi.events.models.server_now", holder)
    return holder


@pytest.fixture
def app(goals_backend: GoalsBackend, clock: Clock) -> FastAPI:
    return build_app(goals_backend.install)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(app) as c:
        yield c


def auth(kind: str = "web") -> dict[str, str]:
    return bearer(DEVICE, kind)


async def edit_milestone(client: httpx.AsyncClient, page_id: str, **body: Any) -> httpx.Response:
    return await client.patch(f"/v1/milestones/{page_id}", json=body, headers=auth())


async def edits(client: httpx.AsyncClient, status: str | None = None) -> list[dict[str, Any]]:
    params = {"status": status} if status else {}
    resp = await client.get("/v1/goal-edits", params=params, headers=auth())
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]  # type: ignore[no-any-return]


async def goals(client: httpx.AsyncClient) -> dict[str, Any]:
    resp = await client.get("/v1/goals", headers=auth())
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


async def shown(client: httpx.AsyncClient, page_id: str) -> dict[str, Any]:
    body = await goals(client)
    return next(m for m in body["milestones"] if m["page_id"] == page_id)


async def milestone_0711(backend: GoalsBackend, **kw: Any) -> str:
    await backend.outcome("O1")
    return await backend.milestone("m1", "O1", due=date(2026, 11, 7), **kw)


def types(resp: httpx.Response) -> list[str]:
    return [e["type"] for e in resp.json()["errors"]]


async def apply(backend: GoalsBackend, fake: FakeNotionApplier) -> ApplySummary:
    return await apply_pending(backend.edits, backend.goals, fake, APPLIED_AT)


# ---------------------------------------------------------------------------
# PATCH: a pending row, never the mirror
# ---------------------------------------------------------------------------


async def test_a_due_date_edit_is_pending_with_its_dated_note(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    resp = await edit_milestone(client, page, due_date="2026-11-14")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["page_id"], body["due_date"], body["pending"]) == (
        page,
        "2026-11-14",
        ["due_date"],
    )
    [row] = await edits(client, "pending")
    assert (row["target_kind"], row["page_id"], row["field"]) == ("milestone", page, "due_date")
    assert (row["old_value"], row["new_value"]) == ("2026-11-07", "2026-11-14")
    assert row["note"] == NOTE_0714
    assert (row["status"], row["applied_at"], row["error"]) == ("pending", None, None)
    # the mirror itself is untouched
    [mirror] = [m for m in await goals_backend.goals.milestones() if m.page_id == page]
    assert mirror.due_date == date(2026, 11, 7)


async def test_a_second_edit_supersedes_the_pending_one_and_keeps_the_base_value(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, clock: Clock
) -> None:
    page = await milestone_0711(goals_backend)
    assert (await edit_milestone(client, page, due_date="2026-11-14")).status_code == 200
    clock.now = datetime(2026, 11, 11, 8, 5, tzinfo=UTC)
    resp = await edit_milestone(client, page, due_date="2026-11-21")
    assert resp.status_code == 200 and resp.json()["due_date"] == "2026-11-21"
    rows = await edits(client)
    assert [r["status"] for r in rows] == ["pending", "superseded"]  # newest first
    assert rows[1]["new_value"] == "2026-11-14"
    assert rows[0]["old_value"] == "2026-11-07"
    assert rows[0]["note"].endswith("من «2026-11-07» إلى «2026-11-21»")


@pytest.mark.parametrize(
    "body",
    [
        {"title": "عنوان آخر"},
        {"card_page_ids": ["t13_c9"]},
        {"outcome_code": "O2"},
        {"cycle_no": 3},
        {"criterion": "معيار"},
        {"due_date": "2026-11-14", "title": "عنوان"},
    ],
)
async def test_a_field_that_is_not_editable_is_refused(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, body: dict[str, Any]
) -> None:
    page = await milestone_0711(goals_backend)
    resp = await edit_milestone(client, page, **body)
    assert resp.status_code == 422, resp.text
    assert "field_not_editable" in types(resp)
    assert await edits(client) == []


async def test_a_card_field_other_than_its_status_is_refused(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    card = await goals_backend.card("c1", status="قيد التنفيذ")
    for body in (
        {"title": "x"},
        {"outcome_codes": ["O2"]},
        {"target_date": "2027-01-01"},
        {"next_step": "x"},
        {"done": True},
    ):
        resp = await client.patch(f"/v1/cards/{card}", json=body, headers=auth())
        assert resp.status_code == 422, body
        assert types(resp) == ["field_not_editable"], body
    assert await edits(client) == []


async def test_an_empty_body_is_refused(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    resp = await edit_milestone(client, page)
    assert resp.status_code == 422 and types(resp) == ["empty_patch"]
    card = await goals_backend.card("c1", status="قيد التنفيذ")
    resp = await client.patch(f"/v1/cards/{card}", json={}, headers=auth())
    assert resp.status_code == 422


@pytest.mark.parametrize("day", ["2032-01-01", "2026-10-30"])
async def test_a_due_date_outside_the_plan_is_refused(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, day: str
) -> None:
    page = await milestone_0711(goals_backend)
    resp = await edit_milestone(client, page, due_date=day)
    assert resp.status_code == 422 and types(resp) == ["due_date_out_of_range"]
    for edge in ("2026-10-31", "2031-12-31"):
        assert (await edit_milestone(client, page, due_date=edge)).status_code == 200


async def test_null_values_and_long_evidence_are_refused(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    for body in ({"due_date": None}, {"done": None}, {"done": "yes"}, {"evidence": "x" * 501}):
        assert (await edit_milestone(client, page, **body)).status_code == 422, body
    assert (await edit_milestone(client, page, evidence="x" * 500)).status_code == 200


async def test_done_and_evidence_edits_change_the_counts_of_the_outcome(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    resp = await edit_milestone(client, page, done=True, evidence="رابط الشهادة")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["done"], body["evidence"]) == (True, "رابط الشهادة")
    assert sorted(body["pending"]) == ["done", "evidence"]
    notes = {r["field"]: r["note"] for r in await edits(client, "pending")}
    assert notes["done"].endswith("من «مفتوحة» إلى «منجزة»")
    assert notes["evidence"].endswith("من «—» إلى «رابط الشهادة»")
    whole = await goals(client)
    [o1] = [o for o in whole["outcomes"] if o["code"] == "O1"]
    assert (o1["milestones_done"], o1["completion"]) == (1, 1.0)
    assert whole["pending_edits"] == 2


async def test_a_card_status_must_be_a_status_of_the_mirror(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    card = await goals_backend.card("c1", status="قيد التنفيذ")
    await goals_backend.card("c2", status="مكتملة")
    resp = await client.patch(f"/v1/cards/{card}", json={"status": "حالة جديدة"}, headers=auth())
    assert resp.status_code == 422 and types(resp) == ["status_unknown"]
    resp = await client.patch(f"/v1/cards/{card}", json={"status": "مكتملة"}, headers=auth())
    assert resp.status_code == 200, resp.text
    assert (resp.json()["status"], resp.json()["pending"]) == ("مكتملة", ["status"])
    [row] = await edits(client)
    assert (row["target_kind"], row["old_value"], row["new_value"]) == (
        "card",
        "قيد التنفيذ",
        "مكتملة",
    )
    assert row["note"] == "2026-11-11 · يومي: الحالة من «قيد التنفيذ» إلى «مكتملة»"


async def test_an_unknown_page_is_a_404(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    card = await goals_backend.card("c1", status="قيد التنفيذ")
    assert (await edit_milestone(client, "t13_nothing", done=True)).status_code == 404
    assert (await edit_milestone(client, card, done=True)).status_code == 404
    resp = await client.patch(f"/v1/cards/{page}", json={"status": "قيد التنفيذ"}, headers=auth())
    assert resp.status_code == 404


async def test_there_is_no_delete_route(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    card = await goals_backend.card("c1", status="قيد التنفيذ")
    assert (await client.delete(f"/v1/milestones/{page}", headers=auth())).status_code == 405
    assert (await client.delete(f"/v1/cards/{card}", headers=auth())).status_code == 405


async def test_a_value_equal_to_the_mirror_writes_no_row(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    resp = await edit_milestone(client, page, due_date="2026-11-07", done=False)
    assert resp.status_code == 200
    assert (resp.json()["due_date"], resp.json()["pending"]) == ("2026-11-07", [])
    assert await edits(client) == []


async def test_editing_back_to_the_base_value_drops_the_pending_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    resp = await edit_milestone(client, page, due_date="2026-11-07")
    assert (resp.json()["due_date"], resp.json()["pending"]) == ("2026-11-07", [])
    assert [r["status"] for r in await edits(client)] == ["superseded"]


async def test_cancelling_a_pending_edit_brings_back_the_mirror_value(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, clock: Clock
) -> None:
    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    [row] = await edits(client)
    clock.now = datetime(2026, 11, 12, 6, 0, tzinfo=UTC)
    resp = await client.post(f"/v1/goal-edits/{row['id']}/cancel", headers=auth())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["id"], body["status"]) == (row["id"], "cancelled")
    # a dated note is added, the first one kept: nothing is deleted
    assert body["note"] == NOTE_0714 + "\n2026-11-12 · يومي: إلغاء التعديل"
    assert [r["status"] for r in await edits(client, "cancelled")] == ["cancelled"]
    m = await shown(client, page)
    assert (m["due_date"], m["pending"]) == ("2026-11-07", [])
    assert (await goals(client))["pending_edits"] == 0
    again = await client.post(f"/v1/goal-edits/{row['id']}/cancel", headers=auth())
    assert again.status_code == 409


async def test_a_conflict_can_be_cancelled_and_stays_in_the_log(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    await apply(goals_backend, FakeNotionApplier(live={(page, "due_date"): "2026-11-10"}))
    [row] = await edits(client)
    assert row["status"] == "conflict"
    resp = await client.post(f"/v1/goal-edits/{row['id']}/cancel", headers=auth())
    assert resp.status_code == 200 and resp.json()["status"] == "cancelled"
    assert [r["id"] for r in await edits(client)] == [row["id"]]


async def test_a_failed_edit_cannot_be_cancelled(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    await apply(goals_backend, FakeNotionApplier(live={}, fail_on={page}))
    [row] = await edits(client)
    assert row["status"] == "failed"
    resp = await client.post(f"/v1/goal-edits/{row['id']}/cancel", headers=auth())
    assert resp.status_code == 409


async def test_an_applied_or_unknown_edit_cannot_be_cancelled(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    await apply(goals_backend, FakeNotionApplier(live={(page, "due_date"): "2026-11-07"}))
    [row] = await edits(client)
    assert row["status"] == "applied"
    assert (
        await client.post(f"/v1/goal-edits/{row['id']}/cancel", headers=auth())
    ).status_code == 409
    unknown = await client.post(f"/v1/goal-edits/{uuid4()}/cancel", headers=auth())
    assert unknown.status_code == 404


async def test_goals_count_the_pending_edits(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    assert (await goals(client))["pending_edits"] == 0
    await edit_milestone(client, page, due_date="2026-11-14")
    body = await goals(client)
    assert body["pending_edits"] == 1
    m = next(m for m in body["milestones"] if m["page_id"] == page)
    assert (m["due_date"], m["pending"]) == ("2026-11-14", ["due_date"])


async def test_the_edit_log_filters_by_status_and_lists_newest_first(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, clock: Clock
) -> None:
    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    clock.now = datetime(2026, 11, 11, 8, 10, tzinfo=UTC)
    await edit_milestone(client, page, done=True)
    assert [r["field"] for r in await edits(client)] == ["done", "due_date"]
    assert await edits(client, "applied") == []
    bad = await client.get("/v1/goal-edits", params={"status": "nope"}, headers=auth())
    assert bad.status_code == 422


async def test_a_service_token_cannot_edit_goals(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    service = bearer(DEVICE, "service")
    resp = await client.patch(f"/v1/milestones/{page}", json={"done": True}, headers=service)
    assert resp.status_code == 403
    assert (await client.get("/v1/goal-edits", headers=service)).status_code == 403


# ---------------------------------------------------------------------------
# The overlay after an applied edit (ruling 7)
# ---------------------------------------------------------------------------


async def applied_0714(client: httpx.AsyncClient, backend: GoalsBackend, **kw: Any) -> str:
    page = await milestone_0711(backend, **kw)
    await edit_milestone(client, page, due_date="2026-11-14")
    summary = await apply(backend, FakeNotionApplier(live={(page, "due_date"): "2026-11-07"}))
    assert summary == ApplySummary(applied=1, failed=0, conflicts=0)
    [row] = await edits(client)
    assert (row["status"], row["applied_at"]) == ("applied", "2026-11-11T09:00:00Z")
    return page


async def test_an_applied_edit_shows_while_the_mirror_is_older(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await applied_0714(
        client, goals_backend, edited=datetime(2026, 11, 10, 20, 0, tzinfo=UTC)
    )
    m = await shown(client, page)
    assert (m["due_date"], m["pending"]) == ("2026-11-14", [])
    assert (await goals(client))["pending_edits"] == 0


async def test_an_applied_edit_shows_while_the_mirror_has_no_edit_time(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await applied_0714(client, goals_backend)
    assert (await shown(client, page))["due_date"] == "2026-11-14"


async def test_a_newer_mirror_row_wins_over_an_applied_edit(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await applied_0714(client, goals_backend)
    newer = datetime(2026, 11, 11, 9, 5, tzinfo=UTC)
    await goals_backend.sync("milestone", page, due_date=date(2026, 11, 14), edited=newer)
    assert (await shown(client, page))["due_date"] == "2026-11-14"
    # changed in Notion after the apply: the mirror's value, whatever it is
    await goals_backend.sync("milestone", page, due_date=date(2026, 11, 20), edited=newer)
    m = await shown(client, page)
    assert (m["due_date"], m["pending"]) == ("2026-11-20", [])


# ---------------------------------------------------------------------------
# A second edit after the first was applied (R-3)
# ---------------------------------------------------------------------------


async def test_a_second_edit_after_an_applied_one_expects_the_applied_value(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, clock: Clock
) -> None:
    page = await applied_0714(
        client, goals_backend, edited=datetime(2026, 11, 10, 20, 0, tzinfo=UTC)
    )
    clock.now = datetime(2026, 11, 11, 9, 30, tzinfo=UTC)
    resp = await edit_milestone(client, page, due_date="2026-11-21")
    assert resp.status_code == 200 and resp.json()["pending"] == ["due_date"]
    [second] = await edits(client, "pending")
    assert second["old_value"] == "2026-11-14"
    assert second["note"].endswith("من «2026-11-14» إلى «2026-11-21»")
    fake = FakeNotionApplier(live={(page, "due_date"): "2026-11-14"})
    summary = await apply_pending(
        goals_backend.edits, goals_backend.goals, fake, datetime(2026, 11, 11, 10, 0, tzinfo=UTC)
    )
    assert summary == ApplySummary(applied=1, failed=0, conflicts=0)
    assert [c.new_value for c in fake.calls] == ["2026-11-21"]
    assert fake.live[(page, "due_date")] == "2026-11-21"
    assert [r["status"] for r in await edits(client)] == ["applied", "applied"]
    assert (await shown(client, page))["due_date"] == "2026-11-21"


# ---------------------------------------------------------------------------
# apply_pending with the fake applier
# ---------------------------------------------------------------------------


async def test_pending_edits_are_applied_in_creation_order(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, clock: Clock
) -> None:
    await goals_backend.outcome("O1")
    late = await goals_backend.milestone("m2", "O1", due=date(2026, 12, 1))
    early = await goals_backend.milestone("m1", "O1", due=date(2026, 11, 7))
    card = await goals_backend.card("c1", status="قيد التنفيذ")
    await goals_backend.card("c2", status="مكتملة")
    await edit_milestone(client, early, due_date="2026-11-14")
    clock.now = datetime(2026, 11, 11, 8, 1, tzinfo=UTC)
    await client.patch(f"/v1/cards/{card}", json={"status": "مكتملة"}, headers=auth())
    clock.now = datetime(2026, 11, 11, 8, 2, tzinfo=UTC)
    await edit_milestone(client, late, done=True)
    fake = FakeNotionApplier(
        live={
            (early, "due_date"): "2026-11-07",
            (card, "status"): "قيد التنفيذ",
            (late, "done"): False,
        }
    )
    summary = await apply(goals_backend, fake)
    assert summary == ApplySummary(applied=3, failed=0, conflicts=0)
    assert [(c.page_id, c.field) for c in fake.calls] == [
        (early, "due_date"),
        (card, "status"),
        (late, "done"),
    ]
    assert fake.calls[0].note == NOTE_0714
    assert fake.calls[0].old_value == "2026-11-07"
    for c in fake.calls:
        assert c.field in EDITABLE[c.target_kind]
    assert fake.live == {
        (early, "due_date"): "2026-11-14",
        (card, "status"): "مكتملة",
        (late, "done"): True,
    }
    assert await apply(goals_backend, fake) == ApplySummary(0, 0, 0)  # nothing left
    assert len(fake.calls) == 3


async def test_a_live_value_that_changed_is_a_conflict_and_nothing_is_written(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)  # the mirror lags: Notion already holds the 10th
    await edit_milestone(client, page, due_date="2026-11-14")
    fake = FakeNotionApplier(live={(page, "due_date"): "2026-11-10"})
    assert await apply(goals_backend, fake) == ApplySummary(applied=0, failed=0, conflicts=1)
    assert len(fake.calls) == 1
    assert fake.live[(page, "due_date")] == "2026-11-10"
    [row] = await edits(client)
    assert (row["status"], row["applied_at"]) == ("conflict", None)
    m = await shown(client, page)
    assert (m["due_date"], m["pending"]) == ("2026-11-07", [])


async def test_a_base_value_that_moved_is_a_conflict_without_calling_the_applier(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    # the mirror caught up with another value set in Notion
    await goals_backend.sync(
        "milestone",
        page,
        due_date=date(2026, 11, 9),
        edited=datetime(2026, 11, 11, 8, 30, tzinfo=UTC),
    )
    fake = FakeNotionApplier(live={(page, "due_date"): "2026-11-09"})
    assert await apply(goals_backend, fake) == ApplySummary(applied=0, failed=0, conflicts=1)
    assert fake.calls == []
    assert [r["status"] for r in await edits(client)] == ["conflict"]


async def test_a_failed_apply_keeps_the_error_and_stays_in_the_log(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    fake = FakeNotionApplier(live={(page, "due_date"): "2026-11-07"}, fail_on={page})
    assert await apply(goals_backend, fake) == ApplySummary(applied=0, failed=1, conflicts=0)
    [row] = await edits(client, "failed")
    assert row["error"] == "تعذّر الوصول إلى الصفحة" and row["applied_at"] is None
    assert fake.live[(page, "due_date")] == "2026-11-07"
    # a new edit of the same field is possible after a failure
    assert (await edit_milestone(client, page, due_date="2026-11-15")).status_code == 200


async def test_an_applier_that_raises_marks_the_edit_failed(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    class Broken:
        async def apply(self, change: Any) -> Any:
            raise RuntimeError("boom")

    page = await milestone_0711(goals_backend)
    await edit_milestone(client, page, due_date="2026-11-14")
    summary = await apply_pending(goals_backend.edits, goals_backend.goals, Broken(), APPLIED_AT)
    assert summary == ApplySummary(applied=0, failed=1, conflicts=0)
    [row] = await edits(client)
    assert row["status"] == "failed" and row["error"] and "boom" not in row["error"]
