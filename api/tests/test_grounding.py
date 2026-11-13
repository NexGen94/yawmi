"""Server-built grounding (design §10, §7.2): the browser sends the question and the range only.

`build_grounding` reads habits, logs, journal, mood, focus, breath and the mirror (with the goal
edits laid over it) and hands the provider `context` and `sources`; the server turns the cited
sources into `cards` and `days`. Every route test runs on the in-memory stores and on Postgres.
"""

import json
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
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
from yawmi.ai.consent import Consent
from yawmi.ai.grounding import (
    MAX_SOURCE_TEXT,
    MAX_SOURCES,
    Grounding,
    build_grounding,
    span_for,
)
from yawmi.ai.reader import InMemorySessionReader, SessionDay, StoreGroundingReader
from yawmi.ai.schema import InsightRequest, InsightResponse, Source, insight_json_schema
from yawmi.ai.service import InsightInvalid, InsightService
from yawmi.journal.memory import InMemoryJournalReader
from yawmi.journal.store import JournalRow, MoodRow
from yawmi.prefs.models import SettingsOut
from yawmi.today.memory import InMemoryTodayReader
from yawmi.today.reader import CycleRow, GoalRow, HabitRow, LogRow, MilestoneRow

WALK = f"habit:{PREFIX}walk"
WALK_MEMORY = "habit:walk"  # the pure cases below use bare codes
EVENING = "journal:2026-11-10:evening"


@pytest.fixture
def client(ai_client: httpx.AsyncClient) -> httpx.AsyncClient:
    return ai_client


async def walk_twice(ai: AiBackend) -> None:
    """«المشي», a daily habit done on two days of this week (Sunday 2026-11-08 to DAY)."""
    await ai.goals.habit("walk", title="المشي", start=date(2026, 10, 1))
    await ai.goals.log("walk", date(2026, 11, 8), None)
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


async def test_a_done_day_of_last_week_is_not_counted_this_week(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    """I-1: «هذا الأسبوع» is the calendar week (Sunday 2026-11-08 to Saturday 2026-11-14), as for
    weekly habits; 2026-11-05 is in the last seven days but in last week."""
    await ai.goals.habit("walk", title="المشي", start=date(2026, 10, 1))
    await ai.goals.log("walk", date(2026, 11, 5), None)
    await ai.goals.log("walk", date(2026, 11, 9), None)
    ai.provider.script = [citing(WALK)]
    await consent(client)
    resp = await close(client)
    assert resp.status_code == 200, resp.text
    assert ai.provider.sources()[WALK]["text"] == "المشي: 1 من 7 هذا الأسبوع"
    [card] = resp.json()["cards"]
    assert card["value"] == 1
    assert card["trend"] == [0, 1, 0, 0, 0, 1, 0]  # the trend stays the last seven days


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


async def test_the_mission_and_vision_are_sent_only_with_personal_text(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    texts = {"mission": "رسالة مكتوبة", "vision": "رؤية مكتوبة"}
    patched = await client.patch("/v1/settings", json=texts, headers=auth())
    assert patched.status_code == 200, patched.text
    await consent(client, personal_text=False)
    assert (await ask(client)).status_code == 200
    assert "mission" not in ai.provider.sources()
    assert "vision" not in ai.provider.sources()
    await consent(client, personal_text=True)
    assert (await ask(client)).status_code == 200
    for key, text in texts.items():
        assert ai.provider.sources()[key] == {"id": key, "kind": key, "text": text}


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
    assert card["trend"] == [0, 0, 0, 0, 1, 1, 0]  # 2026-11-04 .. 2026-11-10
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


def test_the_ai_error_bodies_reuse_the_validation_error_shape() -> None:
    """M-4: two error shapes only (`yawmi/errors.py`): the coded AI errors are published as
    `ValidationErrorBody`, a service-token 403 as `ErrorDetail`; no third schema name."""
    from api_harness import build_app

    spec = build_app(lambda app: None).openapi()
    assert "AiErrorBody" not in spec["components"]["schemas"]
    body = "#/components/schemas/ValidationErrorBody"
    detail = "#/components/schemas/ErrorDetail"

    def refs(path: str, method: str, status: str) -> set[str]:
        schema = spec["paths"][path][method]["responses"][status]["content"]["application/json"]
        options = schema["schema"].get("anyOf", [schema["schema"]])
        return {o["$ref"] for o in options}

    for path in ("/v1/day/close", "/v1/ask"):
        assert refs(path, "post", "403") == {body, detail}
        assert refs(path, "post", "502") == {body}
        assert refs(path, "post", "503") == {body}
    assert refs("/v1/ai/consent", "put", "409") == {body}


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


# --- fix round 1: pure build_grounding cases (in memory) ---------------------------------------


def habit_row(code: str, title: str, **kw: Any) -> HabitRow:
    return HabitRow(
        code=code,
        title_ar=title,
        kind="boolean",
        unit=None,
        target_per_period=Decimal(1),
        period="day",
        schedule_kind=kw.get("schedule_kind", "every_day"),
        weekday_mask=None,
        every_n=kw.get("every_n"),
        anchor_day=kw.get("anchor_day"),
        start_day=date(2026, 1, 1),
        end_day=None,
    )


def milestone_row(key: str, due: date, done: bool = False) -> MilestoneRow:
    return MilestoneRow(key, "محطة " + key, "O1", 1, due, done)


def journal_row(day: date, part: str, note: str) -> JournalRow:
    when = datetime(2026, 11, 10, tzinfo=UTC)
    return JournalRow(day, part, {"note": note}, when)  # type: ignore[arg-type]


async def ground_memory(
    *,
    habits: Sequence[HabitRow] = (),
    logs: Sequence[LogRow] = (),
    entries: Sequence[JournalRow] = (),
    milestones: Sequence[MilestoneRow] = (),
    goals: Sequence[GoalRow] = (),
    span: tuple[date, date] = (DAY - timedelta(days=6), DAY),
) -> Grounding:
    reader = StoreGroundingReader(
        InMemoryTodayReader(
            habits=list(habits),
            logs=list(logs),
            milestone_rows=list(milestones),
            goal_rows=list(goals),
        ),
        InMemoryJournalReader(entries=list(entries)),
        InMemorySessionReader(),
        None,
    )
    consent = Consent("anthropic", False, datetime(2026, 11, 1, tzinfo=UTC))
    return await build_grounding("ask", DAY, span, reader, SettingsOut(), consent)


def ids(grounding: Grounding) -> list[str]:
    return [s.id for s in grounding.sources]


async def test_a_habit_with_no_scheduled_day_this_week_is_no_source() -> None:
    """M-1: never «0 من 0 هذا الأسبوع» (every 30 days from 2026-10-20: none on 11-08 to 11-14)."""
    rare = habit_row(
        "rare", "نادرة", schedule_kind="every_n_days", every_n=30, anchor_day=date(2026, 10, 20)
    )
    grounding = await ground_memory(habits=[rare, habit_row("walk", "المشي")])
    assert ids(grounding) == ["habit:walk"]


async def test_an_open_overdue_milestone_is_a_source_even_before_the_span() -> None:
    """M-2: late items are what the app is about; a done one before the span is not."""
    late = milestone_row("late", DAY - timedelta(days=8))
    old = milestone_row("old", DAY - timedelta(days=8), done=True)
    grounding = await ground_memory(milestones=[late, old])
    assert ids(grounding) == ["ms:late"]
    assert grounding.sources[0].text == "محطة late، موعدها 2026-11-02، مفتوحة"


async def test_the_milestone_cap_keeps_the_nearest_to_the_day() -> None:
    """M-2: of 14 candidates the 12 nearest to the day stay (DAY+12 and DAY+13 go)."""
    ahead = [milestone_row(f"m{n:02d}", DAY + timedelta(days=n)) for n in range(1, 14)]
    late = milestone_row("late", DAY - timedelta(days=2))
    grounding = await ground_memory(milestones=[*ahead, late])
    kept = ids(grounding)
    assert len(kept) == 12
    assert "ms:late" in kept
    assert "ms:m12" not in kept
    assert "ms:m13" not in kept
    assert kept[0] == "ms:late"  # shown by due date


async def test_sixty_sources_are_kept_whole_and_one_more_drops_the_oldest_journal() -> None:
    """I-2 at the limit: 30 days of morning and evening entries are 60 sources, all kept; one
    habit more drops the oldest journal source and keeps the habit."""
    span = (DAY - timedelta(days=29), DAY)
    entries = [
        journal_row(DAY - timedelta(days=n), part, f"يوم {n}")
        for n in range(30)
        for part in ("morning", "evening")
    ]
    whole = await ground_memory(entries=entries, span=span)
    assert MAX_SOURCES == 60
    assert len(whole.sources) == MAX_SOURCES
    over = await ground_memory(entries=entries, habits=[habit_row("walk", "المشي")], span=span)
    kept = ids(over)
    assert len(kept) == MAX_SOURCES
    assert kept[0] == "habit:walk"
    oldest = (DAY - timedelta(days=29)).isoformat()
    assert f"journal:{oldest}:morning" not in kept
    assert f"journal:{oldest}:evening" in kept
    assert [c.source_id for c in over.cards] == kept


async def test_a_cycle_question_on_day_85_is_bounded_and_keeps_the_current_period() -> None:
    """I-2, the review's case: day 85 of a cycle with a morning and an evening entry each day
    (170 journal sources). Journal goes first, oldest day first; habits and goals stay."""
    start = DAY - timedelta(days=84)
    cycles = [CycleRow(1, start, DAY + timedelta(days=40), DAY + timedelta(days=47))]
    span = span_for("cycle", DAY, cycles)
    assert span == (start, DAY)
    entries = [
        journal_row(DAY - timedelta(days=n), part, "ن" * 2000)
        for n in range(85)
        for part in ("morning", "evening")
    ]
    grounding = await ground_memory(
        entries=entries,
        habits=[habit_row("walk", "المشي")],
        milestones=[milestone_row("m1", DAY + timedelta(days=3))],
        goals=[GoalRow("O1", "الصحة", date(2031, 12, 31), "active", "المسار")],
        span=span,
    )
    kept = ids(grounding)
    assert len(kept) == MAX_SOURCES
    assert kept[:3] == ["habit:walk", "ms:m1", "goal:O1"]
    journal = [i for i in kept if i.startswith("journal:")]
    assert len(journal) == 57
    assert journal[0] == f"journal:{(DAY - timedelta(days=28)).isoformat()}:evening"
    assert journal[-1] == f"journal:{DAY.isoformat()}:evening"
    assert sum(len(s.text) for s in grounding.sources) <= MAX_SOURCES * MAX_SOURCE_TEXT
    assert [c.source_id for c in grounding.cards] == kept


async def test_a_long_source_text_is_cut_to_500_with_an_ellipsis() -> None:
    """I-2: per-source text cap; on a word boundary when one is near, else exactly at the cap."""
    words = " ".join(["كلمة"] * 200)  # 999 characters with spaces
    yesterday = DAY - timedelta(days=1)
    grounding = await ground_memory(
        entries=[
            journal_row(DAY, "morning", "س" * 2000),
            journal_row(DAY, "evening", words),
            journal_row(yesterday, "evening", "ص" * MAX_SOURCE_TEXT),
        ],
    )
    by_id = {s.id: s.text for s in grounding.sources}
    solid = by_id[f"journal:{DAY.isoformat()}:morning"]
    assert len(solid) == MAX_SOURCE_TEXT
    assert solid == "س" * (MAX_SOURCE_TEXT - 1) + "…"
    spaced = by_id[f"journal:{DAY.isoformat()}:evening"]
    assert len(spaced) <= MAX_SOURCE_TEXT
    assert spaced.endswith("كلمة…")
    assert by_id[f"journal:{yesterday.isoformat()}:evening"] == "ص" * MAX_SOURCE_TEXT
    assert {c.source_id: c.text for c in grounding.cards} == by_id


# --- task 19, ruling N-1: the four day kinds are dropped together, oldest day first -----------


async def ground_days(days: int, *, extra_habits: int = 0) -> tuple[Grounding, list[date]]:
    """`days` days ending on DAY, each with an evening journal, a mood, a focus and a breath
    day, plus «المشي», one open milestone and one outcome (and `extra_habits` more habits)."""
    span = (DAY - timedelta(days=days - 1), DAY)
    every = [DAY - timedelta(days=n) for n in range(days)]
    reader = StoreGroundingReader(
        InMemoryTodayReader(
            habits=[
                habit_row("walk", "المشي"),
                *(habit_row(f"h{n}", f"عادة {n}") for n in range(extra_habits)),
            ],
            milestone_rows=[milestone_row("m1", DAY + timedelta(days=3))],
            goal_rows=[GoalRow("O1", "الصحة", date(2031, 12, 31), "active", "المسار")],
        ),
        InMemoryJournalReader(
            entries=[journal_row(d, "evening", f"يومية {d.isoformat()}") for d in every],
            moods=[MoodRow(d, 3, [], []) for d in every],
        ),
        InMemorySessionReader(
            focus=[SessionDay(d, 1, 25) for d in every],
            breath=[SessionDay(d, 1, 5) for d in every],
        ),
        None,
    )
    consent = Consent("anthropic", False, datetime(2026, 11, 1, tzinfo=UTC))
    grounding = await build_grounding("ask", DAY, span, reader, SettingsOut(), consent)
    return grounding, every


def kept_days(grounding: Grounding, kind: str) -> list[date]:
    return [c.day for c in grounding.cards if c.kind == kind]  # type: ignore[misc]


async def test_a_thirty_day_range_keeps_the_latest_days_of_all_four_day_kinds() -> None:
    """120 day sources and 3 others: the 3 stay, and the 57 day sources are the 14 newest days
    whole plus the breath of the 15th (inside a day: journal, mood, focus, then breath go)."""
    grounding, every = await ground_days(30)
    kept = ids(grounding)
    assert len(kept) == MAX_SOURCES
    assert kept[:3] == [WALK_MEMORY, "ms:m1", "goal:O1"]
    newest = sorted(every[:14])
    for kind in ("journal", "mood", "focus"):
        assert kept_days(grounding, kind) == newest, kind
    assert kept_days(grounding, "breath") == sorted(every[:15])
    assert [c.source_id for c in grounding.cards] == kept


async def test_the_cap_stays_exact_and_whole_days_are_kept_when_the_count_allows() -> None:
    """4 others and 56 day sources: exactly 14 whole days of each kind."""
    grounding, every = await ground_days(30, extra_habits=1)
    assert len(grounding.sources) == MAX_SOURCES
    for kind in ("journal", "mood", "focus", "breath"):
        assert kept_days(grounding, kind) == sorted(every[:14]), kind


async def test_current_habits_and_goals_are_never_dropped_before_a_day_source() -> None:
    """Twenty habits, a milestone and a goal (22) leave 38 places for the day sources: every
    habit, the milestone and the goal stay, and the day sources are the newest: 9 whole days and
    the focus and breath of the 10th."""
    grounding, every = await ground_days(30, extra_habits=19)
    kept = ids(grounding)
    assert len(kept) == MAX_SOURCES
    assert sum(1 for i in kept if i.startswith("habit:")) == 20
    assert {"ms:m1", "goal:O1"} <= set(kept)
    for kind in ("journal", "mood"):
        assert kept_days(grounding, kind) == sorted(every[:9]), kind
    for kind in ("focus", "breath"):
        assert kept_days(grounding, kind) == sorted(every[:10]), kind
    day_sources = [c for c in grounding.cards if c.day is not None]
    assert len(day_sources) == 38
    assert min(c.day for c in day_sources) == every[9]  # type: ignore[type-var]
