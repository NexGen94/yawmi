"""`GET /v1/goals` on the memory and the Postgres backend (design §7.4, §8.4 and §9.3).

The server's day is 2026-11-10 (the pinned clock of `conftest.py`).
"""

import re
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import httpx
import pytest
from api_harness import auth_header as bearer
from api_harness import build_app, http_client
from fastapi import FastAPI
from goals_harness import PREFIX, GoalsBackend

from yawmi.goals import reader as reader_module
from yawmi.goals.reader import card_target_date

TODAY = date(2026, 11, 10)
TODAY_NOW = datetime(2026, 11, 10, 12, tzinfo=UTC)
DEVICE = "00000000-0000-7000-8000-000000000413"


@pytest.fixture
def app(goals_backend: GoalsBackend) -> FastAPI:
    return build_app(goals_backend.install)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(app) as c:
        yield c


def headers(kind: str = "web") -> dict[str, str]:
    return bearer(UUID(DEVICE), kind)


async def get_goals(client: httpx.AsyncClient) -> dict[str, Any]:
    resp = await client.get("/v1/goals", headers=headers())
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def outcome_of(body: dict[str, Any], code: str) -> dict[str, Any]:
    return next(o for o in body["outcomes"] if o["code"] == code)


async def test_an_empty_mirror_is_an_empty_state_not_an_error(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await goals_backend.pause_other_habits()
    body = await get_goals(client)
    assert body == {
        "outcomes": [],
        "cycles": [],
        "milestones": [],
        "cards": [],
        "synced_at": None,
        "pending_edits": 0,
    }


async def test_the_goals_need_a_user_device(client: httpx.AsyncClient) -> None:
    assert (await client.get("/v1/goals")).status_code == 401
    assert (await client.get("/v1/goals", headers=headers("service"))).status_code == 403


async def test_completion_and_due_milestones_of_an_outcome(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    for n in range(1, 13):
        await b.outcome(f"O{n}")
    # O1: 12 milestones, 3 done, 4 due by the 10th (two of the due ones are done, plus one more)
    due = [date(2026, 11, 1), date(2026, 11, 5), date(2026, 11, 8), date(2026, 11, 10)]
    for i in range(12):
        await b.milestone(
            f"m{i}",
            "O1",
            due=due[i] if i < 4 else date(2027, 1, 1 + i),
            done=i in (0, 1, 5),
        )
    body = await get_goals(client)
    assert [o["code"] for o in body["outcomes"]] == [f"O{n}" for n in range(1, 13)]
    o1 = outcome_of(body, "O1")
    assert (o1["milestones_total"], o1["milestones_done"]) == (12, 3)
    assert o1["completion"] == 0.25
    assert o1["milestones_due"] == 4
    assert outcome_of(body, "O2")["completion"] is None
    assert body["synced_at"] is not None


async def test_an_open_milestone_past_its_due_day_counts_the_days_overdue(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.outcome("O1")
    await b.milestone("late", "O1", due=date(2026, 11, 8))
    await b.milestone("done", "O1", due=date(2026, 11, 8), done=True)
    await b.milestone("today", "O1", due=TODAY)
    await b.milestone("later", "O1", due=date(2026, 11, 20))
    await b.milestone("none", "O1")
    by_id = {m["page_id"]: m for m in (await get_goals(client))["milestones"]}
    assert by_id[PREFIX + "late"]["overdue_days"] == 2
    for key in ("done", "today", "later", "none"):
        assert by_id[PREFIX + key]["overdue_days"] is None, key
    assert all(m["pending"] == [] for m in by_id.values())


async def test_track_acceptance_and_the_milestone_texts_come_from_the_mirror(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.outcome("O3", track="المسار الصحي", acceptance="معيار القبول", title="مخرج ثلاثة")
    await b.milestone("c", "O3", criterion="معيار المحطة", evidence="رابط الدليل", cycle=2)
    body = await get_goals(client)
    o3 = outcome_of(body, "O3")
    assert (o3["track"], o3["acceptance"], o3["title"]) == (
        "المسار الصحي",
        "معيار القبول",
        "مخرج ثلاثة",
    )
    assert o3["target_date"] == "2031-12-31" and o3["status"] == "active"
    m = body["milestones"][0]
    assert (m["criterion"], m["evidence"], m["cycle_no"]) == ("معيار المحطة", "رابط الدليل", 2)
    assert m["outcome_code"] == "O3" and m["card_page_ids"] == []


async def test_the_next_milestone_is_the_nearest_open_one(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.outcome("O1")
    await b.milestone("far", "O1", due=date(2027, 3, 1))
    await b.milestone("near", "O1", due=date(2026, 12, 1))
    await b.milestone("done", "O1", due=date(2026, 10, 1), done=True)
    nxt = outcome_of(await get_goals(client), "O1")["next_milestone"]
    assert nxt["page_id"] == PREFIX + "near"


async def test_card_target_date_and_next_step_come_from_the_named_property_keys(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.card(
        "a",
        title="حجز الاختبار",
        props={"المستهدف": {"start": "2026-12-31", "end": None}, "الخطوة التالية": "حجز الاختبار"},
    )
    await b.card("a_str", props={"المستهدف": "2027-01-15T09:00:00+03:00"})
    await b.card("none", props={"شيء آخر": 1})
    await b.card("text", props={"المستهدف": "قريباً"})
    await b.card("empty_obj", props={"المستهدف": {"start": None}})
    await b.card("secret", props={"السبب العميق (لماذا؟)": "نص شخصي لا يُقرأ"})
    cards = {c["page_id"]: c for c in (await get_goals(client))["cards"]}
    assert cards[PREFIX + "a"]["target_date"] == "2026-12-31"
    assert cards[PREFIX + "a"]["next_step"] == "حجز الاختبار"
    assert cards[PREFIX + "a_str"]["target_date"] == "2027-01-15"
    for key in ("none", "text", "empty_obj"):
        assert cards[PREFIX + key]["target_date"] is None, key
    assert cards[PREFIX + "none"]["next_step"] is None
    assert cards[PREFIX + "text"]["next_step"] is None
    assert "نص شخصي" not in str(cards)
    assert all(c["pending"] == [] for c in cards.values())


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("2026-12-31", date(2026, 12, 31)),
        ("2026-12-31T10:00:00.000+03:00", date(2026, 12, 31)),
        ("2026-13-45", None),
        ("قريباً", None),
        ("", None),
        (None, None),
        (5, None),
    ],
)
def test_the_card_target_date_is_the_first_ten_characters(text: Any, expected: date | None) -> None:
    assert card_target_date(text) == expected


def test_no_query_of_the_goals_reader_reads_the_private_columns_or_selects_star() -> None:
    """`props` and `note` are never granted to `yawmi_api`; the card view is read by name."""
    statements = [
        value
        for name, value in vars(reader_module).items()
        if isinstance(value, str) and re.match(r"\s*(SELECT|WITH)\b", value, re.IGNORECASE)
    ]
    assert len(statements) >= 8
    for sql in statements:
        words = set(re.findall(r"[a-z_]+", sql.lower()))
        assert "props" not in words, sql
        assert "note" not in words, sql
        assert "*" not in sql, sql
    assert any("yawmi_ro.notion_card_fields" in sql for sql in statements)


async def test_cycles_milestones_and_kpis_are_listed(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.cycle(1, date(2026, 10, 31), date(2026, 12, 31), date(2027, 1, 7))
    await b.outcome("O12")
    await b.kpi("workshops_count", "O12", target=12, unit="ورشة")
    await b.reading("workshops_count", date(2026, 11, 1), 1)
    await b.reading("workshops_count", date(2026, 11, 9), 2)
    await b.kpi("steps_avg", None, target=8000)
    body = await get_goals(client)
    cycle = body["cycles"][0]
    assert (cycle["cycle_no"], cycle["start_date"], cycle["theme"], cycle["gate"]) == (
        1,
        "2026-10-31",
        "موضوع",
        "بوابة",
    )
    kpis = outcome_of(body, "O12")["kpis"]
    assert [k["code"] for k in kpis] == ["workshops_count"]
    assert kpis[0]["target"] == 12 and kpis[0]["latest"] == {"day": "2026-11-09", "value": 2}


async def test_a_kpi_without_a_reading_has_no_latest(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await goals_backend.outcome("O12")
    await goals_backend.kpi("workshops_count", "O12", target=12)
    assert outcome_of(await get_goals(client), "O12")["kpis"][0]["latest"] is None


async def test_the_default_indicator_follows_milestones_then_habits_then_tasks(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.pause_other_habits()
    for code in ("O1", "O2", "O3"):
        await b.outcome(code)
    await b.milestone("m1", "O1", done=True, due=date(2026, 11, 1))
    await b.milestone("m2", "O1", due=date(2026, 12, 1))
    await b.habit("h", outcome="O2")
    await b.log("h", TODAY, None)
    await b.task("O3", "مهمة ١", done=True)
    await b.task("O3", "مهمة ٢")
    body = await get_goals(client)
    o1, o2, o3 = (outcome_of(body, c)["indicator"] for c in ("O1", "O2", "O3"))
    assert (o1["source"], o1["value"], o1["target"], o1["completion"]) == ("milestones", 1, 2, 0.5)
    assert o1["custom"] is False and o1["display"] == "ring"
    assert (o2["source"], o2["completion"]) == ("linked_habits", 1.0)
    assert (o3["source"], o3["value"], o3["target"], o3["completion"]) == ("tasks", 1, 2, 0.5)


async def test_an_outcome_with_nothing_to_measure_has_an_empty_indicator(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await goals_backend.outcome("O5")
    ind = outcome_of(await get_goals(client), "O5")["indicator"]
    assert (ind["source"], ind["value"], ind["completion"]) == ("tasks", None, None)


async def test_a_stored_indicator_beats_the_default_and_is_custom(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.outcome("O1")
    await b.milestone("m1", "O1", done=True, due=date(2026, 11, 1))
    await b.task("O1", "أ", done=True)
    await b.task("O1", "ب")
    await b.task("O1", "ج")
    await b.task("O1", "د")
    await b.put_indicator(subject_ref="O1", source="tasks", display="bar", target=2)
    ind = outcome_of(await get_goals(client), "O1")["indicator"]
    assert ind["custom"] is True and ind["display"] == "bar" and ind["source"] == "tasks"
    assert (ind["value"], ind["target"], ind["completion"]) == (1, 2, 0.5)


async def test_card_counts_habits_tasks_and_indicator(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.pause_other_habits()
    card = await b.card("c1", outcomes=["O1"], status="قيد التنفيذ")
    await b.outcome("O1")
    await b.milestone("m1", "O1", cards=["c1"], done=True, due=date(2026, 11, 1))
    await b.milestone("m2", "O1", cards=["c1"], due=date(2026, 12, 1))
    await b.milestone("m3", "O1", due=date(2026, 12, 1))
    await b.habit("hc", goal_ref=card)
    await b.log("hc", TODAY, None)
    await b.task(card, "مهمة", done=True)
    gone = await b.task(card, "مهمة مؤرشفة")
    await b.tasks.patch(UUID(gone), {"archived": True}, TODAY_NOW)
    await b.put_indicator(subject_ref=card, source="tasks")
    out = next(c for c in (await get_goals(client))["cards"] if c["page_id"] == card)
    assert (out["milestones_total"], out["milestones_done"]) == (2, 1)
    assert (out["tasks_total"], out["tasks_done"]) == (1, 1)  # the archived task is left out
    assert out["habits"][0]["code"] == PREFIX + "hc"
    assert out["status"] == "قيد التنفيذ" and out["outcome_codes"] == ["O1"]
    assert out["indicator"]["custom"] is True and out["indicator"]["completion"] == 1.0
    assert out["pending"] == []
