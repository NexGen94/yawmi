"""`POST /v1/insights/morning`, `weekly` and `deeper` (design §7.1, §10).

The morning insight is stored once per day and shown by `GET /v1/today`; the weekly one once per
week, keyed by the week's first day, on the weekly model, and a service token may ask for it; the
go-deeper reply is one question with up to three alternatives and is never stored. A weekly reply
must name the recurring theme through at least two different `journal:*` sources whenever the
range holds two or more. Every route runs on the in-memory stores and on Postgres.
"""

from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

import httpx
import pytest
from ai_harness import DAY, AiBackend, auth, citing, empty_reply
from goals_harness import PREFIX

from yawmi.ai.store import week_key

WALK = f"habit:{PREFIX}walk"
MORNING = "/v1/insights/morning"
WEEKLY = "/v1/insights/weekly"
DEEPER = "/v1/insights/deeper"
WEEK_FIRST = date(2026, 11, 8)  # Sunday; the week of DAY (Tuesday 2026-11-10)
J08 = "journal:2026-11-08:evening"
J09 = "journal:2026-11-09:evening"
J10 = "journal:2026-11-10:morning"


@pytest.fixture
def client(ai_client: httpx.AsyncClient) -> httpx.AsyncClient:
    return ai_client


async def consent(client: httpx.AsyncClient) -> None:
    resp = await client.put("/v1/ai/consent", json={"provider": "anthropic"}, headers=auth())
    assert resp.status_code == 200, resp.text


async def post(
    client: httpx.AsyncClient, path: str, day: date = DAY, kind: str = "web", **body: Any
) -> httpx.Response:
    return await client.post(path, json={"day": day.isoformat(), **body}, headers=auth(kind))


async def seed_day(ai: AiBackend) -> None:
    """«المشي» done twice this week, yesterday's evening journal and today's mood."""
    await ai.goals.habit("walk", title="المشي", start=date(2026, 10, 1))
    await ai.goals.log("walk", date(2026, 11, 8), None)
    await ai.goals.log("walk", date(2026, 11, 9), None)
    await ai.journal_entry(date(2026, 11, 9), "evening", {"note": "يوم طويل في العمل"})
    await ai.mood(DAY, 4, ["هادئ"])


async def seed_journals(ai: AiBackend, *keys: str) -> None:
    for key in keys:
        _, day, part = key.split(":")
        await ai.journal_entry(date.fromisoformat(day), part, {"note": f"الاجتماعات {day}"})


def three_priorities(payload: dict[str, Any]) -> dict[str, Any]:
    ids = [s["id"] for s in payload["sources"]][:3]
    return {
        "lines": ["سطر أول.", "سطر ثانٍ."],
        "question": None,
        "source_ids": ids[:1],
        "priorities": [{"title": f"أولوية {n}", "source_id": i} for n, i in enumerate(ids)],
    }


def deeper_reply(payload: dict[str, Any]) -> dict[str, Any]:
    ids = [s["id"] for s in payload["sources"]]
    titles = [
        "ما الذي ساعد على المشي يومين؟",
        "ما الذي جعل اليوم طويلاً في العمل؟",
        "أي خطوة صغيرة تجعل الغد أهدأ؟ " + "ـ" * 50,  # exactly 80 characters
    ]
    return {
        "lines": [],
        "question": "ما الذي يستحق التأمل في هذا الأسبوع؟",
        "source_ids": ids[:1],
        "priorities": [{"title": t, "source_id": ids[n % len(ids)]} for n, t in enumerate(titles)],
    }


def citing_journals(*ids: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    return citing(*ids, lines=["الاجتماعات تكررت.", "سطر ثانٍ."])


# --- morning -----------------------------------------------------------------------------------


async def test_the_morning_insight_is_made_once_a_day_and_shown_by_today(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_day(ai)
    ai.provider.script = [three_priorities]
    await consent(client)
    first = await post(client, MORNING)
    assert first.status_code == 200, first.text
    again = await post(client, MORNING)
    assert again.status_code == 200, again.text
    assert again.json()["id"] == first.json()["id"]
    assert len(ai.provider.calls) == 1
    assert ai.provider.calls[0]["model"] == "claude-haiku-5-5"
    assert ai.provider.payload["kind"] == "morning"

    today = await client.get("/v1/today", headers=auth())
    assert today.status_code == 200, today.text
    insight = today.json()["insight"]
    assert insight["id"] == first.json()["id"]
    assert insight["kind"] == "morning"
    assert 1 <= len(insight["priorities"]) <= 3
    card_ids = {c["source_id"] for c in insight["cards"]}
    assert {p["source_id"] for p in insight["priorities"]} <= card_ids
    assert set(insight["source_ids"]) <= card_ids
    assert len(ai.provider.calls) == 1  # /v1/today never calls the provider


async def test_a_four_priority_morning_reply_is_never_stored(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_day(ai)
    four = {
        **empty_reply(),
        "priorities": [{"title": f"أولوية {n}", "source_id": WALK} for n in range(4)],
    }
    ai.provider.script = [four, four]
    await consent(client)
    resp = await post(client, MORNING)
    assert resp.status_code == 502
    assert resp.json()["errors"][0]["type"] == "ai_invalid_reply"
    assert len(ai.provider.calls) == 2
    assert await ai.insight_count() == 0


async def test_morning_regenerate_calls_again_only_when_the_sources_changed(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_day(ai)
    await consent(client)
    first = (await post(client, MORNING)).json()
    same = await post(client, MORNING, regenerate=True)
    assert same.json()["id"] == first["id"]
    assert len(ai.provider.calls) == 1
    await ai.goals.log("walk", DAY, None)
    renewed = await post(client, MORNING, regenerate=True)
    assert renewed.status_code == 200, renewed.text
    assert renewed.json()["id"] == first["id"]  # the row is renewed in place
    assert len(ai.provider.calls) == 2
    assert len(await ai.stored("morning", DAY)) == 1


async def test_a_future_morning_is_a_422(ai: AiBackend, client: httpx.AsyncClient) -> None:
    await consent(client)
    resp = await post(client, MORNING, day=date(2026, 11, 11))
    assert resp.status_code == 422
    assert resp.json()["errors"][0]["type"] == "day_in_future"
    assert ai.provider.calls == []


# --- weekly ------------------------------------------------------------------------------------


def test_the_week_key_is_the_first_day_of_the_week() -> None:
    assert week_key(date(2026, 11, 12), "sun") == date(2026, 11, 8)
    assert week_key(date(2026, 11, 8), "sun") == date(2026, 11, 8)
    assert week_key(date(2026, 11, 14), "sun") == date(2026, 11, 8)
    assert week_key(date(2026, 11, 15), "sun") == date(2026, 11, 15)
    assert week_key(date(2026, 11, 12), "mon") == date(2026, 11, 9)
    assert week_key(date(2026, 11, 12), "sat") == date(2026, 11, 7)


async def test_every_day_of_the_week_returns_the_same_weekly_row(
    ai: AiBackend, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With the clock on Saturday 2026-11-14, any day from 11-08 to 11-14 is the same week."""
    monkeypatch.setattr(
        "yawmi.events.models.server_now", lambda: datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
    )
    await seed_day(ai)
    await consent(client)
    first = await post(client, WEEKLY, day=WEEK_FIRST)
    assert first.status_code == 200, first.text
    assert first.json()["kind"] == "weekly"
    assert first.json()["day"] == "2026-11-08"
    for n in range(9, 15):
        resp = await post(client, WEEKLY, day=date(2026, 11, n))
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == first.json()["id"], n
    assert len(ai.provider.calls) == 1
    assert ai.provider.calls[0]["model"] == "claude-sonnet-5-5"
    assert ai.provider.payload["kind"] == "weekly"
    [row] = await ai.stored("weekly", WEEK_FIRST)
    assert row.model == "claude-sonnet-5-5"
    reviews = await client.get("/v1/reviews", headers=auth())
    assert [r["id"] for r in reviews.json()["items"]] == [first.json()["id"]]


async def test_a_service_token_may_ask_for_the_weekly_insight_only(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await consent(client)
    weekly = await post(client, WEEKLY, kind="service")
    assert weekly.status_code == 200, weekly.text
    for path in (MORNING, DEEPER):
        resp = await post(client, path, kind="service")
        assert resp.status_code == 403, path
    assert len(ai.provider.calls) == 1


async def test_a_weekly_reply_citing_one_journal_of_three_is_repaired_once_then_a_502(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_journals(ai, J08, J09, J10)
    ai.provider.script = [citing_journals(J08), citing_journals(J08)]
    await consent(client)
    resp = await post(client, WEEKLY)
    assert resp.status_code == 502, resp.text
    assert resp.json()["errors"][0]["type"] == "ai_invalid_reply"
    assert len(ai.provider.calls) == 2
    assert "[تصحيح]" in ai.provider.calls[1]["user"]
    assert "journal" in ai.provider.calls[1]["user"].split("[تصحيح]", 1)[1]
    assert await ai.stored("weekly", WEEK_FIRST) == []


async def test_a_weekly_reply_citing_two_different_journals_is_accepted(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_journals(ai, J08, J09, J10)
    ai.provider.script = [citing_journals(J08, J10)]
    await consent(client)
    resp = await post(client, WEEKLY)
    assert resp.status_code == 200, resp.text
    assert len(ai.provider.calls) == 1
    body = resp.json()
    assert body["source_ids"] == [J08, J10]
    assert body["days"] == ["2026-11-08", "2026-11-10"]


async def test_a_weekly_reply_citing_the_same_journal_twice_is_still_one(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_journals(ai, J08, J09)
    twice = {**empty_reply(), "source_ids": [J08, J08]}
    ai.provider.script = [twice, citing_journals(J08, J09)]
    await consent(client)
    resp = await post(client, WEEKLY)
    assert resp.status_code == 200, resp.text
    assert len(ai.provider.calls) == 2  # the repeated id did not count as two


async def test_with_one_journal_in_the_range_the_theme_rule_does_not_apply(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_journals(ai, J09)
    ai.provider.script = [citing_journals(J09)]
    await consent(client)
    resp = await post(client, WEEKLY)
    assert resp.status_code == 200, resp.text
    assert len(ai.provider.calls) == 1


async def test_the_theme_rule_is_weekly_only(ai: AiBackend, client: httpx.AsyncClient) -> None:
    await seed_journals(ai, J08, J09, J10)
    ai.provider.script = [citing_journals(J10)]
    await consent(client)
    resp = await post(client, MORNING)
    assert resp.status_code == 200, resp.text
    assert len(ai.provider.calls) == 1


# --- go deeper ---------------------------------------------------------------------------------


async def test_go_deeper_returns_one_question_and_three_options_and_stores_nothing(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_day(ai)
    ai.provider.script = [deeper_reply]
    await consent(client)
    before = await ai.insight_count()
    resp = await post(client, DEEPER)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"question", "options", "source_ids", "refusal"}
    assert body["refusal"] is None  # a question, so no refusal
    assert body["question"] == "ما الذي يستحق التأمل في هذا الأسبوع؟"
    assert [o["title"] for o in body["options"]] == [
        p["title"] for p in deeper_reply(ai.provider.payload)["priorities"]
    ]
    assert len(body["options"]) == 3
    assert max(len(o["title"]) for o in body["options"]) == 80
    sent = {s["id"] for s in ai.provider.payload["sources"]}
    assert {o["source_id"] for o in body["options"]} <= sent
    assert set(body["source_ids"]) <= sent
    assert ai.provider.payload["kind"] == "deeper"
    assert await ai.insight_count() == before
    again = await post(client, DEEPER)
    assert again.status_code == 200
    assert len(ai.provider.calls) == 2  # nothing stored, so nothing reused


async def test_go_deeper_without_a_question_is_repaired_once_then_a_502(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_day(ai)
    ai.provider.script = [empty_reply(), empty_reply()]
    await consent(client)
    resp = await post(client, DEEPER)
    assert resp.status_code == 502
    assert len(ai.provider.calls) == 2


async def test_a_go_deeper_option_over_80_characters_is_repaired(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    await seed_day(ai)

    def long_option(payload: dict[str, Any]) -> dict[str, Any]:
        reply = deeper_reply(payload)
        reply["priorities"][0]["title"] = "س" * 81
        return reply

    ai.provider.script = [long_option, deeper_reply]
    await consent(client)
    resp = await post(client, DEEPER)
    assert resp.status_code == 200, resp.text
    assert len(ai.provider.calls) == 2


async def test_go_deeper_takes_the_day_only(ai: AiBackend, client: httpx.AsyncClient) -> None:
    await consent(client)
    resp = await post(client, DEEPER, regenerate=True)
    assert resp.status_code == 422
    assert resp.json()["errors"] == [{"loc": ["body", "regenerate"], "type": "extra_forbidden"}]
    assert ai.provider.calls == []


# --- shared: style, consent, the client cannot send sources ------------------------------------


@pytest.mark.parametrize("path", [MORNING, WEEKLY, DEEPER])
async def test_the_reply_style_reaches_the_context(
    ai: AiBackend, client: httpx.AsyncClient, path: str
) -> None:
    patched = await client.patch(
        "/v1/settings", json={"ai_tone": "explained", "ai_lines": 1}, headers=auth()
    )
    assert patched.status_code == 200, patched.text
    ai.provider.script = [deeper_reply if path == DEEPER else empty_reply()]
    await seed_day(ai)
    await consent(client)
    resp = await post(client, path)
    assert resp.status_code == 200, resp.text
    assert ai.provider.payload["context"]["style"] == {"lines": 1, "tone": "explained"}


@pytest.mark.parametrize("path", [MORNING, WEEKLY, DEEPER])
async def test_every_new_kind_needs_consent(
    ai: AiBackend, client: httpx.AsyncClient, path: str
) -> None:
    resp = await post(client, path)
    assert resp.status_code == 403
    assert resp.json()["errors"][0]["type"] == "ai_consent_required"
    assert ai.provider.calls == []


@pytest.mark.parametrize("path", [MORNING, WEEKLY, DEEPER])
@pytest.mark.parametrize("field", ["context", "sources"])
async def test_a_client_context_or_sources_is_a_422(
    ai: AiBackend, client: httpx.AsyncClient, path: str, field: str
) -> None:
    await consent(client)
    resp = await post(client, path, **{field: []})
    assert resp.status_code == 422
    assert resp.json()["errors"] == [{"loc": ["body", field], "type": "extra_forbidden"}]
    assert ai.provider.calls == []


# --- fix round 1, I-1: the out-of-scope and no-data lines are valid replies of every kind -----

OUT_OF_SCOPE = "هذا خارج نطاق المتابعة اليومية، والمختص هو المرجع المناسب."
NO_DATA = "لا بيانات كافية."
CLOSE = "/v1/day/close"
DIAGNOSIS_LENS = "تشخيص حالتي النفسية من اليوميات"


def fixed(line: str) -> dict[str, Any]:
    return {"lines": [line], "question": None, "source_ids": [], "priorities": []}


@pytest.mark.parametrize("line", [OUT_OF_SCOPE, NO_DATA])
@pytest.mark.parametrize("path", [MORNING, CLOSE, WEEKLY])
async def test_a_fixed_line_is_a_valid_stored_reply_of_every_kind(
    ai: AiBackend, client: httpx.AsyncClient, path: str, line: str
) -> None:
    """Two journals in the week would otherwise call for the theme rule on `weekly`."""
    await seed_journals(ai, J08, J09)
    ai.provider.script = [fixed(line)]
    await consent(client)
    resp = await post(client, path)
    assert resp.status_code == 200, resp.text
    assert resp.json()["lines"] == [line]
    assert resp.json()["source_ids"] == [] and resp.json()["cards"] == []
    assert len(ai.provider.calls) == 1


@pytest.mark.parametrize(
    ("line", "refusal"), [(OUT_OF_SCOPE, "out_of_scope"), (NO_DATA, "no_data")]
)
async def test_go_deeper_answers_a_fixed_line_with_a_null_question_and_its_refusal(
    ai: AiBackend, client: httpx.AsyncClient, line: str, refusal: str
) -> None:
    """`refusal` names the fixed line, set exactly when `question` is null."""
    await seed_day(ai)
    ai.provider.script = [fixed(line)]
    await consent(client)
    resp = await post(client, DEEPER)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "question": None,
        "options": [],
        "source_ids": [],
        "refusal": refusal,
    }
    assert len(ai.provider.calls) == 1


@pytest.mark.parametrize("path", [WEEKLY, DEEPER])
async def test_a_diagnosis_lens_is_one_call_and_a_200_never_a_502(
    ai: AiBackend, client: httpx.AsyncClient, path: str
) -> None:
    """The review's probe: a diagnosis lens, two journals in the week, the rule 9 reply."""
    created = await client.post(
        "/v1/ai/memory", json={"kind": "rule", "text": DIAGNOSIS_LENS}, headers=auth()
    )
    assert created.status_code == 201, created.text
    await seed_journals(ai, J08, J09)
    ai.provider.script = [fixed(OUT_OF_SCOPE)]
    await consent(client)
    resp = await post(client, path)
    assert resp.status_code == 200, resp.text
    assert len(ai.provider.calls) == 1


async def test_a_fixed_line_does_not_excuse_a_reply_that_cites_sources(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    """Only the exact shape (the line alone, no question, nothing cited) skips the theme rule."""
    await seed_journals(ai, J08, J09)
    dodge = {**fixed(OUT_OF_SCOPE), "source_ids": [J08]}
    ai.provider.script = [dodge, dodge]
    await consent(client)
    resp = await post(client, WEEKLY)
    assert resp.status_code == 502
    assert len(ai.provider.calls) == 2


async def test_go_deeper_with_a_fixed_line_and_a_question_is_repaired(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    """The question is null exactly when the reply is one of the two fixed lines."""
    await seed_day(ai)
    mixed = {**fixed(NO_DATA), "question": "ما الذي يستحق التأمل؟"}
    ai.provider.script = [mixed, deeper_reply]
    await consent(client)
    resp = await post(client, DEEPER)
    assert resp.status_code == 200, resp.text
    assert resp.json()["question"]
    assert len(ai.provider.calls) == 2


# --- fix round 1, M-5 and M-6: a changed fingerprint renews a stored morning or weekly row ----


async def test_an_early_weekly_row_is_renewed_once_the_week_moves_on(
    ai: AiBackend, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "yawmi.events.models.server_now", lambda: datetime(2026, 11, 8, 12, 0, tzinfo=UTC)
    )
    await seed_journals(ai, J08)
    await consent(client)
    first = await post(client, WEEKLY, day=WEEK_FIRST)
    assert first.status_code == 200, first.text
    monkeypatch.setattr(
        "yawmi.events.models.server_now", lambda: datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
    )
    await seed_journals(ai, J09, J10)
    ai.provider.script = [citing_journals(J09, J10)]
    later = await post(client, WEEKLY, day=DAY, kind="service")
    assert later.status_code == 200, later.text
    assert later.json()["id"] == first.json()["id"]  # renewed in place
    assert later.json()["source_ids"] == [J09, J10]
    assert len(ai.provider.calls) == 2
    [row] = await ai.stored("weekly", WEEK_FIRST)
    assert row.response.source_ids == [J09, J10]
    again = await post(client, WEEKLY, day=DAY)
    assert again.json()["id"] == first.json()["id"]
    assert len(ai.provider.calls) == 2  # same fingerprint: the stored row


async def test_the_weekly_fingerprint_does_not_depend_on_the_day_asked(
    ai: AiBackend, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The week's span and its key are fixed, so asking for another day of the same week with
    the same data is the same request."""
    monkeypatch.setattr(
        "yawmi.events.models.server_now", lambda: datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
    )
    await seed_journals(ai, J08, J09)
    ai.provider.script = [citing_journals(J08, J09)]
    await consent(client)
    assert (await post(client, WEEKLY, day=WEEK_FIRST)).status_code == 200
    assert (await post(client, WEEKLY, day=date(2026, 11, 12))).status_code == 200
    assert len(ai.provider.calls) == 1
    span = ai.provider.payload["context"]["span"]
    assert span == {"first": "2026-11-08", "last": "2026-11-14"}
    assert ai.provider.payload["day"] == "2026-11-08"


async def test_a_stored_morning_refusal_is_renewed_after_its_lens_is_removed(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    lens = await client.post(
        "/v1/ai/memory", json={"kind": "rule", "text": DIAGNOSIS_LENS}, headers=auth()
    )
    await seed_day(ai)
    ai.provider.script = [fixed(OUT_OF_SCOPE), three_priorities]
    await consent(client)
    refused = await post(client, MORNING)
    assert refused.json()["lines"] == [OUT_OF_SCOPE]
    assert (await post(client, MORNING)).json()["lines"] == [OUT_OF_SCOPE]
    assert len(ai.provider.calls) == 1  # unchanged: the stored row
    deleted = await client.delete(f"/v1/ai/memory/{lens.json()['id']}", headers=auth())
    assert deleted.status_code == 204
    renewed = await post(client, MORNING)
    assert renewed.status_code == 200, renewed.text
    assert renewed.json()["id"] == refused.json()["id"]
    assert renewed.json()["lines"] != [OUT_OF_SCOPE]
    assert len(ai.provider.calls) == 2
    today = await client.get("/v1/today", headers=auth())
    assert today.json()["insight"]["lines"] == renewed.json()["lines"]


def test_deeper_out_sets_refusal_exactly_when_the_question_is_null() -> None:
    from pydantic import ValidationError

    from yawmi.ai.cards import DeeperOut

    assert DeeperOut(question="ما الذي؟", options=[], source_ids=[], refusal=None).refusal is None
    assert DeeperOut(question=None, options=[], source_ids=[], refusal="no_data").question is None
    for bad in (
        {"question": None, "refusal": None},
        {"question": "ما الذي؟", "refusal": "out_of_scope"},
        {"question": None, "refusal": "other"},
    ):
        with pytest.raises(ValidationError):
            DeeperOut(options=[], source_ids=[], **bad)


def test_the_spec_publishes_the_deeper_refusal_codes() -> None:
    from yawmi.auth.memory_store import InMemoryDeviceStore
    from yawmi.main import create_app

    schema = create_app(devices=InMemoryDeviceStore()).openapi()["components"]["schemas"]
    refusal = schema["DeeperOut"]["properties"]["refusal"]
    codes = {v for option in refusal["anyOf"] for v in option.get("enum", [])}
    assert codes == {"out_of_scope", "no_data"}
    assert {"type": "null"} in refusal["anyOf"]
    assert "refusal" in schema["DeeperOut"]["required"]
