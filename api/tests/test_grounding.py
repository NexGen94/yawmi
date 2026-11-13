"""Server-built grounding (design §10, §7.2): the browser sends the question and the range only.

`build_grounding` reads habits, logs, journal, mood, focus, breath and the mirror (with the goal
edits laid over it) and hands the provider `context` and `sources`; the server turns the cited
sources into `cards` and `days`. Every route test runs on the in-memory stores and on Postgres.
"""

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import pytest
from ai_harness import (
    DAY,
    AiBackend,
    RecordingProvider,
    auth,
    citing,
    empty_reply,
    make_settings,
)
from goals_harness import PREFIX

from yawmi.ai.cards import GroundedInsight, InsightOut, SourceCard, cards_for, days_of
from yawmi.ai.grounding import Grounding, span_for
from yawmi.ai.schema import InsightRequest, InsightResponse, Source, insight_json_schema
from yawmi.ai.service import InsightInvalid, InsightService
from yawmi.today.reader import CycleRow

WALK = f"habit:{PREFIX}walk"
EVENING = "journal:2026-11-10:evening"


@pytest.fixture
def client(ai_client: httpx.AsyncClient) -> httpx.AsyncClient:
    return ai_client


async def walk_twice(ai: AiBackend) -> None:
    """«المشي», a daily habit done on two of the last seven days."""
    await ai.goals.habit("walk", title="المشي", start=date(2026, 10, 1))
    await ai.goals.log("walk", date(2026, 11, 5), None)
    await ai.goals.log("walk", date(2026, 11, 9), None)


async def consent(client: httpx.AsyncClient, personal_text: bool = False) -> None:
    body = {"provider": "anthropic", "personal_text": personal_text}
    resp = await client.put("/v1/ai/consent", json=body, headers=auth())
    assert resp.status_code == 200, resp.text


async def close(client: httpx.AsyncClient, **body: Any) -> httpx.Response:
    return await client.post("/v1/day/close", json={"day": DAY.isoformat(), **body}, headers=auth())


async def ask(client: httpx.AsyncClient, **body: Any) -> httpx.Response:
    return await client.post(
        "/v1/ask", json={"question": "كيف كان الأسبوع؟", **body}, headers=auth()
    )


# --- what the provider receives ----------------------------------------------------------------


async def test_a_habit_done_two_of_seven_days_reaches_the_provider_as_a_source(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await walk_twice(ai)
    await consent(client)
    resp = await close(client)
    assert resp.status_code == 200, resp.text
    assert ai.provider.sources()[WALK] == {
        "id": WALK,
        "kind": "habit",
        "text": "المشي: 2 من 7 هذا الأسبوع",
    }


@pytest.mark.parametrize("field", ["context", "sources"])
@pytest.mark.parametrize("route", ["/v1/day/close", "/v1/ask"])
async def test_a_client_context_or_sources_is_a_422(
    ai: AiBackend, client: httpx.AsyncClient, route: str, field: str
) -> None:
    await consent(client)
    base: dict[str, Any] = (
        {"day": DAY.isoformat()} if route == "/v1/day/close" else {"question": "سؤال"}
    )
    value: Any = {"k": 1} if field == "context" else [{"id": "a", "kind": "k", "text": "t"}]
    resp = await client.post(route, json={**base, field: value}, headers=auth())
    assert resp.status_code == 422
    assert resp.json()["errors"] == [{"loc": ["body", field], "type": "extra_forbidden"}]
    assert ai.provider.calls == []


async def test_the_days_journal_is_a_source_in_its_own_words(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await ai.journal_entry(DAY, "evening", {"win": "أنهيت التقرير", "note": "يوم هادئ"})
    await consent(client)
    assert (await close(client)).status_code == 200
    assert ai.provider.sources()[EVENING] == {
        "id": EVENING,
        "kind": "journal",
        "text": "أنهيت التقرير · يوم هادئ",
    }


async def test_the_mission_is_sent_only_with_personal_text(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    patched = await client.patch("/v1/settings", json={"mission": "رسالة مكتوبة"}, headers=auth())
    assert patched.status_code == 200, patched.text
    await consent(client, personal_text=False)
    assert (await ask(client)).status_code == 200
    assert "mission" not in ai.provider.sources()
    await consent(client, personal_text=True)
    assert (await ask(client)).status_code == 200
    assert ai.provider.sources()["mission"] == {
        "id": "mission",
        "kind": "mission",
        "text": "رسالة مكتوبة",
    }


async def test_no_daily_metric_reaches_the_context(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await ai.metrics(DAY, 77)
    await walk_twice(ai)
    await consent(client)
    assert (await close(client)).status_code == 200
    context = ai.provider.payload["context"]
    assert set(context) == {"span", "style"}
    sent = json.dumps(ai.provider.payload, ensure_ascii=False)
    for word in ("recovery", "strain", "sleep", "raw_samples", "77"):
        assert word not in sent, word


async def test_a_thirty_day_range_reads_thirty_days_and_days_are_the_cited_days(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await ai.journal_entry(date(2026, 10, 12), "evening", {"note": "أول المدى"})
    await ai.journal_entry(date(2026, 10, 11), "evening", {"note": "قبل المدى"})
    await ai.journal_entry(date(2026, 11, 1), "morning", {"note": "منتصف المدى"})
    await walk_twice(ai)
    ai.provider.script = [citing("journal:2026-10-12:evening", WALK)]
    await consent(client)
    resp = await ask(client, range="30d")
    assert resp.status_code == 200, resp.text
    assert ai.provider.payload["context"]["span"] == {"first": "2026-10-12", "last": "2026-11-10"}
    ids = set(ai.provider.sources())
    assert {"journal:2026-10-12:evening", "journal:2026-11-01:morning"} <= ids
    assert "journal:2026-10-11:evening" not in ids
    body = resp.json()
    assert body["days"] == ["2026-10-12"]
    assert [c["source_id"] for c in body["cards"]] == ["journal:2026-10-12:evening", WALK]
    assert set(body) == {"lines", "question", "source_ids", "priorities", "cards", "days"}


async def test_the_default_range_is_seven_days(ai: AiBackend, client: httpx.AsyncClient) -> None:
    await consent(client)
    assert (await ask(client)).status_code == 200
    assert ai.provider.payload["context"]["span"] == {"first": "2026-11-04", "last": "2026-11-10"}


async def test_the_habit_card_carries_label_value_unit_and_a_seven_day_trend(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await walk_twice(ai)
    ai.provider.script = [citing(WALK)]
    await consent(client)
    resp = await close(client)
    assert resp.status_code == 200, resp.text
    [card] = resp.json()["cards"]
    assert card["source_id"] == WALK
    assert card["kind"] == "habit"
    assert card["label"] == "المشي"
    assert card["value"] == 2
    assert card["unit"] == "من 7"
    assert card["text"] == "المشي: 2 من 7 هذا الأسبوع"
    assert card["trend"] == [0, 1, 0, 0, 0, 1, 0]  # 2026-11-04 .. 2026-11-10
    assert card["day"] is None


async def test_milestones_outcomes_mood_focus_and_breath_are_sources(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await ai.goals.outcome("O1", title="الصحة")
    await ai.goals.milestone("m1", "O1", title="فحص الدم", due=date(2026, 11, 12))
    await ai.goals.milestone("m2", "O1", title="خطة التمرين", due=date(2026, 9, 1), done=True)
    await ai.mood(date(2026, 11, 9), 4, ["هادئ", "ممتن"])
    await ai.focus(date(2026, 11, 8), 25)
    await ai.breath(date(2026, 11, 7), 300)
    await consent(client)
    assert (await close(client)).status_code == 200
    sources = ai.provider.sources()
    assert sources[f"ms:{PREFIX}m1"]["text"] == "فحص الدم، موعدها 2026-11-12، مفتوحة"
    assert f"ms:{PREFIX}m2" not in sources  # due long before the span
    assert sources["goal:O1"] == {"id": "goal:O1", "kind": "outcome", "text": "الصحة: 1 من 2 محطة"}
    assert sources["mood:2026-11-09"]["text"] == "المزاج 4 من 5: هادئ، ممتن"
    assert sources["focus:2026-11-08"]["text"] == "التركيز: 25 دقيقة في 1 جلسة"
    assert sources["breath:2026-11-07"]["text"] == "التنفّس: 5 دقيقة في 1 جلسة"


@pytest.mark.parametrize("applied", [False, True])
async def test_the_milestones_are_read_through_the_goal_edits(
    ai: AiBackend, client: httpx.AsyncClient, applied: bool
) -> None:
    """The AI sees what the user sees: a milestone closed by a pending or an applied edit."""
    await ai.goals.outcome("O1", title="الصحة")
    page = await ai.goals.milestone("m1", "O1", title="فحص الدم", due=date(2026, 11, 7))
    when = datetime(2026, 11, 11, 9, 0, tzinfo=UTC) if applied else None
    await ai.goals.edit("milestone", page, "done", False, True, applied_at=when)
    await consent(client)
    assert (await close(client)).status_code == 200
    sources = ai.provider.sources()
    assert sources[f"ms:{PREFIX}m1"]["text"] == "فحص الدم، موعدها 2026-11-07، منجزة"
    assert sources["goal:O1"]["text"] == "الصحة: 1 من 1 محطة"


async def test_a_weekly_habit_counts_its_current_week(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await ai.goals.habit("gym", title="النادي", period="week", target=3, start=date(2026, 10, 1))
    await ai.goals.log("gym", date(2026, 11, 3), None)  # the week before (Sunday start)
    await ai.goals.log("gym", date(2026, 11, 8), None)
    await consent(client)
    assert (await close(client)).status_code == 200
    assert ai.provider.sources()[f"habit:{PREFIX}gym"]["text"] == "النادي: 1 من 3 هذا الأسبوع"


# --- regenerate --------------------------------------------------------------------------------


async def test_regenerate_with_the_same_fingerprint_returns_the_stored_row(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await walk_twice(ai)
    ai.provider.script = [citing(WALK, lines=["أول."]), citing(WALK, lines=["ثانٍ."])]
    await consent(client)
    first = await close(client)
    again = await close(client, regenerate=True)
    assert again.status_code == 200
    assert again.json() == first.json()
    assert len(ai.provider.calls) == 1

    await ai.goals.log("walk", DAY, None)  # a new habit log changes the sources
    renewed = await close(client, regenerate=True)
    assert renewed.status_code == 200, renewed.text
    assert len(ai.provider.calls) == 2
    assert renewed.json()["lines"] == ["ثانٍ."]
    [row] = await ai.stored("evening", DAY)
    assert row.response.lines == ["ثانٍ."]
    assert [c.text for c in row.cards] == ["المشي: 3 من 7 هذا الأسبوع"]


async def test_a_repeat_without_regenerate_never_calls_the_provider(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await consent(client)
    first = await close(client)
    await ai.goals.habit("walk", title="المشي", start=date(2026, 10, 1))
    again = await close(client)
    assert again.json() == first.json()
    assert len(ai.provider.calls) == 1


async def test_the_seven_day_window_of_the_close_stays(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await consent(client)
    old = await close(client, day=(DAY - timedelta(days=8)).isoformat())
    assert old.status_code == 422
    assert old.json()["errors"] == [{"loc": ["body", "day"], "type": "day_out_of_window"}]
    oldest = await close(client, day=(DAY - timedelta(days=7)).isoformat())
    assert oldest.status_code == 200
    assert len(ai.provider.calls) == 1


# --- days of a stored row (R-6) ----------------------------------------------------------------


async def test_days_are_computed_for_a_stored_row_on_every_reader(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await walk_twice(ai)
    await ai.journal_entry(DAY, "evening", {"note": "مساء"})
    await ai.journal_entry(DAY, "morning", {"note": "صباح"})
    await ai.mood(date(2026, 11, 8), 4, ["هادئ"])
    cited = (EVENING, "mood:2026-11-08", "journal:2026-11-10:morning", WALK)
    ai.provider.script = [citing(*cited)]
    await consent(client)
    expected = ["2026-11-08", "2026-11-10"]

    closed = await close(client)
    assert closed.status_code == 200, closed.text
    assert [c["day"] for c in closed.json()["cards"]] == [
        "2026-11-10",
        "2026-11-08",
        "2026-11-10",
        None,
    ]
    assert closed.json()["days"] == expected

    reviews = await client.get("/v1/reviews?kind=evening", headers=auth())
    assert reviews.json()["items"][0]["days"] == expected
    assert (await close(client)).json()["days"] == expected

    cards = [SourceCard.model_validate(c) for c in closed.json()["cards"]]
    await ai.seed_insight("morning", DAY, cards)
    today = await client.get("/v1/today", headers=auth())
    assert today.status_code == 200, today.text
    insight = today.json()["insight"]
    assert insight["kind"] == "morning"
    assert insight["days"] == expected
    assert len(ai.provider.calls) == 1


async def test_today_never_calls_the_provider_and_is_null_without_a_morning_row(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await consent(client)
    assert (await close(client)).status_code == 200  # an evening row is not the morning one
    calls = len(ai.provider.calls)
    today = await client.get("/v1/today", headers=auth())
    assert today.status_code == 200, today.text
    assert today.json()["insight"] is None
    assert len(ai.provider.calls) == calls


# --- length caps (M-2) -------------------------------------------------------------------------


@pytest.mark.parametrize("line", ["س" * 201, "سطر\nسطر"])
async def test_an_overlong_or_broken_line_is_repaired_once_then_a_502(
    ai: AiBackend, client: httpx.AsyncClient, line: str
) -> None:
    ai.provider.script = [empty_reply([line])]
    await consent(client)
    resp = await close(client)
    assert resp.status_code == 502
    assert resp.json()["errors"] == [{"loc": ["body"], "type": "ai_invalid_reply"}]
    assert len(ai.provider.calls) == 2
    assert await ai.stored("evening", DAY) == []


async def test_a_line_of_exactly_200_passes(ai: AiBackend, client: httpx.AsyncClient) -> None:
    ai.provider.script = [empty_reply(["س" * 200])]
    await consent(client)
    assert (await close(client)).status_code == 200
    assert len(ai.provider.calls) == 1


async def test_one_line_setting_repairs_a_two_line_reply(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    patched = await client.patch("/v1/settings", json={"ai_lines": 1}, headers=auth())
    assert patched.status_code == 200
    ai.provider.script = [empty_reply(["أ.", "ب."]), empty_reply(["أ."])]
    await consent(client)
    resp = await close(client)
    assert resp.status_code == 200, resp.text
    assert resp.json()["lines"] == ["أ."]
    assert len(ai.provider.calls) == 2
    assert ai.provider.payload["context"]["style"] == {"lines": 1, "tone": "direct"}
    assert "سطر واحد" in ai.provider.calls[1]["user"]


def _service_request() -> InsightRequest:
    return InsightRequest(
        kind="evening", day=DAY, sources=[Source(id="habit:x", kind="habit", text="س: 1 من 1")]
    )


@pytest.mark.parametrize(
    ("reply", "reason"),
    [
        ({**empty_reply(), "question": "س" * 201 + "؟"}, "question_too_long"),
        (
            {**empty_reply(), "priorities": [{"title": "ع" * 81, "source_id": "habit:x"}]},
            "priority_too_long",
        ),
        (empty_reply(["س" * 201]), "line_too_long"),
        (empty_reply(["أ\nب"]), "line_break"),
        (empty_reply(["أ.", "ب."]), "too_many_lines"),
    ],
)
async def test_each_cap_is_a_repair_reason(reply: dict[str, Any], reason: str) -> None:
    provider = RecordingProvider(reply)
    service = InsightService(provider, make_settings())
    request = _service_request()
    with pytest.raises(InsightInvalid) as exc:
        await service.generate(request, max_lines=1)
    assert exc.value.reasons == [reason]
    assert len(provider.calls) == 2


async def test_the_caps_allow_their_limits_exactly() -> None:
    reply = {
        "lines": ["س" * 200, "ص" * 200],
        "question": "س" * 200,
        "source_ids": ["habit:x"],
        "priorities": [{"title": "ع" * 80, "source_id": "habit:x"}],
    }
    provider = RecordingProvider(reply)
    out = await InsightService(provider, make_settings()).generate(_service_request())
    assert out.lines == reply["lines"]
    assert len(provider.calls) == 1


# --- the contract (R-2, I-9) -------------------------------------------------------------------


async def test_the_provider_schema_has_no_cards(ai: AiBackend, client: httpx.AsyncClient) -> None:
    await consent(client)
    assert (await close(client)).status_code == 200
    schema = ai.provider.calls[0]["schema"]
    assert schema == insight_json_schema()
    assert set(schema["properties"]) == {"lines", "question", "source_ids", "priorities"}
    assert "cards" not in json.dumps(schema)


def test_the_spec_keeps_insight_response_and_publishes_grounded_insight() -> None:
    from api_harness import build_app

    spec = build_app(lambda app: None).openapi()
    schemas = spec["components"]["schemas"]
    assert "InsightResponse" in schemas
    grounded = schemas["GroundedInsight"]
    assert {"cards", "days"} <= set(grounded["properties"])
    assert {"cards", "days"} <= set(grounded["required"])
    assert {"cards", "days", "id", "kind", "day", "created_at"} <= set(
        schemas["InsightOut"]["required"]
    )
    ask = spec["paths"]["/v1/ask"]["post"]["responses"]["200"]["content"]["application/json"]
    assert ask["schema"]["$ref"] == "#/components/schemas/GroundedInsight"
    today = schemas["TodayOut"]["properties"]["insight"]["anyOf"]
    assert {o.get("$ref") or o.get("type") for o in today} == {
        "#/components/schemas/InsightOut",
        "null",
    }
    for name in ("AskRequest", "DayCloseRequest"):
        assert "context" not in schemas[name]["properties"], name
        assert "sources" not in schemas[name]["properties"], name
    assert _enum(schemas["AskRequest"]["properties"]["range"]) == ["30d", "7d", "cycle"]


def _enum(schema: dict[str, Any]) -> list[str]:
    options = schema.get("anyOf", [schema])
    return sorted(v for o in options for v in o.get("enum", []))


# --- pure helpers ------------------------------------------------------------------------------

CYCLES = [
    CycleRow(1, date(2026, 10, 31), date(2026, 12, 25), date(2027, 1, 1)),
    CycleRow(2, date(2027, 1, 2), date(2027, 2, 26), date(2027, 3, 5)),
]


@pytest.mark.parametrize(
    ("range_", "day", "expected"),
    [
        ("7d", date(2026, 11, 10), (date(2026, 11, 4), date(2026, 11, 10))),
        ("30d", date(2026, 11, 10), (date(2026, 10, 12), date(2026, 11, 10))),
        ("cycle", date(2026, 11, 10), (date(2026, 10, 31), date(2026, 11, 10))),
        ("cycle", date(2027, 1, 1), (date(2026, 10, 31), date(2027, 1, 1))),  # review week
        ("cycle", date(2026, 10, 20), (date(2026, 9, 21), date(2026, 10, 20))),  # no cycle
    ],
)
def test_span_for(range_: Any, day: date, expected: tuple[date, date]) -> None:
    assert span_for(range_, day, CYCLES) == expected


def card(source_id: str, day: date | None) -> SourceCard:
    return SourceCard(
        source_id=source_id, kind="journal", label="ل", value=None, unit=None, text="ن", trend=[],
        day=day,
    )  # fmt: skip


def test_days_of_are_the_distinct_non_empty_days_sorted() -> None:
    cards = [
        card("a", date(2026, 11, 10)),
        card("b", date(2026, 11, 8)),
        card("c", date(2026, 11, 10)),
        card("d", None),
    ]
    assert days_of(cards) == [date(2026, 11, 8), date(2026, 11, 10)]
    assert days_of([]) == []


def test_cards_for_follows_the_citation_order_once_each() -> None:
    grounding = Grounding(
        context={},
        sources=[],
        cards=[card("a", None), card("b", None), card("c", None)],
    )
    assert [c.source_id for c in cards_for(["c", "a", "c", "ghost"], grounding)] == ["c", "a"]


def test_insight_response_is_unchanged_and_the_new_models_extend_it() -> None:
    assert set(InsightResponse.model_fields) == {"lines", "question", "source_ids", "priorities"}
    assert set(GroundedInsight.model_fields) == {*InsightResponse.model_fields, "cards", "days"}
    assert issubclass(InsightOut, GroundedInsight)
    assert set(InsightOut.model_fields) == {
        *GroundedInsight.model_fields,
        *("id", "kind", "day", "created_at"),
    }
