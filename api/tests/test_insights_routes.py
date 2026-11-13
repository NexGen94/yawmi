"""`/v1/day/close`, `/v1/ask`, `/v1/reviews`: auth, validation, provider-error mapping,
idempotent closure. Providers are `respx` mocks; no network, no real key.

Since task 18 the server builds the grounding (the client sends the day, or the question and the
range): the app below holds one habit and the day's evening journal, and a standing consent."""

import json
import logging
import os
import re
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import uuid4

import httpx
import pytest
import respx
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.ai.base import PolicyViolation
from yawmi.ai.consent import InMemoryConsentStore
from yawmi.ai.memory import InMemoryMemoryStore
from yawmi.ai.reader import InMemorySessionReader
from yawmi.ai.schema import InsightResponse
from yawmi.ai.service import InsightService
from yawmi.ai.store import InMemoryInsightStore, new_insight
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.journal.memory import InMemoryJournalReader
from yawmi.journal.store import JournalRow
from yawmi.main import create_app
from yawmi.prefs.memory import InMemoryPrefsStore
from yawmi.settings import Settings
from yawmi.today.memory import InMemoryTodayReader
from yawmi.today.reader import HabitRow, LogRow

SECRET = "test-secret-for-unit-tests-only-0123456789"
FAKE_KEY = "fake-anthropic-key-not-real"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DAY = "2026-11-10"  # "today" in Riyadh under the conftest clock (2026-11-10T12:00Z)

EVENING = f"journal:{DAY}:evening"
WATER = HabitRow(
    code="water",
    title_ar="شرب الماء",
    kind="boolean",
    unit=None,
    target_per_period=Decimal(1),
    period="day",
    schedule_kind="every_day",
    weekday_mask=None,
    every_n=None,
    anchor_day=None,
    start_day=date(2026, 10, 31),
    end_day=None,
)
GOOD: dict[str, Any] = {
    "lines": ["الماء: 5 من 7 أيام هذا الأسبوع.", "يومية المساء: يوم هادئ."],
    "question": None,
    "source_ids": ["habit:water", EVENING],
    "priorities": [{"title": "إكمال أكواب الماء", "source_id": "habit:water"}],
}
# an earlier day's close reads the seven days up to it: the evening journal of DAY is not there
HABIT_ONLY = {**GOOD, "source_ids": ["habit:water"]}
LEAK = "provider-private-detail-xyz"  # stands for any text a provider might put in an error


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(os.environ):
        if key.startswith("YAWMI_"):
            monkeypatch.delenv(key, raising=False)


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "database_url": "postgresql://yawmi_api@localhost:5432/raqib",
        "jwt_secret": SecretStr(SECRET),
        "anthropic_api_key": FAKE_KEY,
        **overrides,
    }
    return Settings(**values)


def build_app(**overrides: Any) -> FastAPI:
    """The app with the server-side grounding in memory and a standing consent."""
    settings = make_settings(**overrides)
    app = create_app(settings=settings, devices=InMemoryDeviceStore())
    app.state.insights_store = InMemoryInsightStore()
    logs = [LogRow("water", date(2026, 11, d), None, "done") for d in (4, 5, 6, 8, 9)]
    app.state.today = InMemoryTodayReader(habits=[WATER], logs=logs)
    when = datetime(2026, 11, 10, 18, 0, tzinfo=UTC)
    app.state.journal = InMemoryJournalReader(
        entries=[JournalRow(date(2026, 11, 10), "evening", {"note": "يوم هادئ"}, when)]
    )
    app.state.sessions = InMemorySessionReader()
    app.state.prefs = InMemoryPrefsStore()
    consents = InMemoryConsentStore()
    consents.rows[settings.ai_provider] = consents.granted(settings.ai_provider, when)
    app.state.ai_consent = consents
    app.state.ai_memory = InMemoryMemoryStore()  # task 19: every request reads the memory
    return app


@pytest.fixture
def app() -> FastAPI:
    return build_app()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def auth(kind: str = "iphone") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(uuid4(), kind, SECRET, 900)}"}


def anthropic_reply(payload: Any, stop_reason: str = "end_turn") -> httpx.Response:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return httpx.Response(
        200,
        json={
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "stop_reason": stop_reason,
        },
    )


def close_body(**overrides: Any) -> dict[str, Any]:
    return {"day": DAY, **overrides}


def ask_body(**overrides: Any) -> dict[str, Any]:
    return {"question": "كم يوماً شربت الماء؟", **overrides}


@pytest.fixture
def anthropic():
    with respx.mock(assert_all_called=False) as mock:
        yield mock.post(ANTHROPIC_URL)


# --- auth ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "/v1/day/close", close_body()),
        ("POST", "/v1/ask", ask_body()),
        ("GET", "/v1/reviews", None),
    ],
)
async def test_requires_a_device_token(client, method, path, body):
    anonymous = await client.request(method, path, json=body)
    assert anonymous.status_code == 401
    assert anonymous.json() == {"detail": "غير مصرّح"}
    service = await client.request(method, path, json=body, headers=auth("service"))
    assert service.status_code == 403
    assert service.json() == {"detail": "غير مسموح"}


# --- day/close -------------------------------------------------------------------------------


async def test_close_returns_the_two_line_summary_and_stores_it(client, app, anthropic):
    anthropic.mock(return_value=anthropic_reply(GOOD))
    response = await client.post("/v1/day/close", json=close_body(), headers=auth())
    assert response.status_code == 200
    body = response.json()
    assert body["lines"] == GOOD["lines"]
    assert body["kind"] == "evening"
    assert body["day"] == DAY
    assert body["source_ids"] == ["habit:water", EVENING]
    assert [c["source_id"] for c in body["cards"]] == ["habit:water", EVENING]
    assert body["days"] == [DAY]
    assert len(body["lines"]) <= 2
    [row] = app.state.insights_store.rows
    assert row.provider == "anthropic"
    assert row.model == "claude-haiku-5-5"
    assert len(row.request_hash) == 64


async def test_close_twice_calls_the_provider_once_and_returns_the_same_row(client, anthropic):
    route = anthropic.mock(return_value=anthropic_reply(GOOD))
    first = await client.post("/v1/day/close", json=close_body(), headers=auth())
    again = await client.post("/v1/day/close", json=close_body(), headers=auth())
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    assert route.call_count == 1


async def test_close_for_another_day_is_a_new_closure(client, app, anthropic):
    anthropic.mock(side_effect=[anthropic_reply(GOOD), anthropic_reply(HABIT_ONLY)])
    await client.post("/v1/day/close", json=close_body(), headers=auth())
    other = await client.post("/v1/day/close", json=close_body(day="2026-11-09"), headers=auth())
    assert other.status_code == 200
    assert len(app.state.insights_store.rows) == 2


async def test_close_rejects_a_fabricated_source_after_one_repair(client, app, anthropic):
    bad = {**GOOD, "source_ids": ["habit:invented"]}
    route = anthropic.mock(return_value=anthropic_reply(bad))
    response = await client.post("/v1/day/close", json=close_body(), headers=auth())
    assert response.status_code == 502
    assert response.json()["errors"] == [{"loc": ["body"], "type": "ai_invalid_reply"}]
    assert route.call_count == 2
    assert app.state.insights_store.rows == []


async def test_a_failed_close_is_retried_by_the_next_call(client, anthropic):
    anthropic.mock(
        side_effect=[
            anthropic_reply({**GOOD, "source_ids": ["nope"]}),
            anthropic_reply({**GOOD, "source_ids": ["nope"]}),
            anthropic_reply(GOOD),
        ]
    )
    assert (
        await client.post("/v1/day/close", json=close_body(), headers=auth())
    ).status_code == 502
    assert (
        await client.post("/v1/day/close", json=close_body(), headers=auth())
    ).status_code == 200


async def test_close_validation_errors_use_the_contract(client):
    future = (date(2026, 11, 10) + timedelta(days=1)).isoformat()
    response = await client.post("/v1/day/close", json=close_body(day=future), headers=auth())
    assert response.status_code == 422
    assert response.json() == {
        "detail": "طلب غير صالح",
        "errors": [{"loc": ["body", "day"], "type": "day_in_future"}],
    }
    missing = await client.post("/v1/day/close", json={}, headers=auth())
    assert missing.status_code == 422
    assert missing.json()["errors"] == [{"loc": ["body", "day"], "type": "missing"}]


async def test_close_refuses_a_day_older_than_seven_days_without_calling_the_provider(
    client, app, anthropic
):
    route = anthropic.mock(return_value=anthropic_reply(GOOD))
    old = (date(2026, 11, 10) - timedelta(days=8)).isoformat()
    response = await client.post("/v1/day/close", json=close_body(day=old), headers=auth())
    assert response.status_code == 422
    assert response.json() == {
        "detail": "طلب غير صالح",
        "errors": [{"loc": ["body", "day"], "type": "day_out_of_window"}],
    }
    assert route.call_count == 0
    assert app.state.insights_store.rows == []


async def test_close_accepts_a_day_exactly_seven_days_back(client, app, anthropic):
    anthropic.mock(return_value=anthropic_reply(HABIT_ONLY))
    oldest = (date(2026, 11, 10) - timedelta(days=7)).isoformat()
    response = await client.post("/v1/day/close", json=close_body(day=oldest), headers=auth())
    assert response.status_code == 200
    assert response.json()["day"] == oldest
    assert len(app.state.insights_store.rows) == 1


async def test_close_in_the_future_is_still_refused_without_calling_the_provider(client, anthropic):
    route = anthropic.mock(return_value=anthropic_reply(GOOD))
    future = (date(2026, 11, 10) + timedelta(days=1)).isoformat()
    response = await client.post("/v1/day/close", json=close_body(day=future), headers=auth())
    assert response.status_code == 422
    assert route.call_count == 0


@pytest.mark.parametrize("route", ["/v1/day/close", "/v1/ask"])
async def test_the_server_grounding_reaches_the_provider_without_raw_samples(
    client, anthropic, route
):
    """Replaces the client-context stripping tests: the client cannot send a context any more,
    and the context the server builds holds no raw health sample."""
    mock = anthropic.mock(return_value=anthropic_reply(GOOD))
    body = ask_body() if route == "/v1/ask" else close_body()
    response = await client.post(route, json=body, headers=auth())
    assert response.status_code == 200
    sent = json.loads(json.loads(mock.calls.last.request.content)["messages"][0]["content"])
    assert {s["id"] for s in sent["sources"]} == {"habit:water", EVENING}
    assert "raw_samples" not in json.dumps(sent)


# --- ask -------------------------------------------------------------------------------------


async def test_ask_answers_and_stores_nothing(client, app, anthropic):
    anthropic.mock(return_value=anthropic_reply(GOOD))
    response = await client.post("/v1/ask", json=ask_body(), headers=auth("web"))
    assert response.status_code == 200
    body = response.json()
    assert {key: body[key] for key in GOOD} == GOOD
    assert [c["source_id"] for c in body["cards"]] == ["habit:water", EVENING]
    assert body["days"] == [DAY]
    assert app.state.insights_store.rows == []


@pytest.mark.parametrize("question", ["", "  ", "س" * 501])
async def test_ask_rejects_bad_questions(client, question):
    response = await client.post("/v1/ask", json=ask_body(question=question), headers=auth())
    assert response.status_code == 422
    assert response.json()["detail"] == "طلب غير صالح"


@pytest.mark.parametrize(
    "extra", [{"sources": []}, {"context": {}}, {"day": DAY}, {"range": "90d"}]
)
async def test_ask_rejects_client_sources_context_day_and_unknown_ranges(client, anthropic, extra):
    route = anthropic.mock(return_value=anthropic_reply(GOOD))
    response = await client.post("/v1/ask", json=ask_body(**extra), headers=auth())
    assert response.status_code == 422
    assert route.call_count == 0


# --- provider errors never become a 500 and never leak ----------------------------------------


@pytest.mark.parametrize(
    ("reply", "status", "code"),
    [
        (anthropic_reply("", stop_reason="refusal"), 422, "ai_refusal"),
        (anthropic_reply(GOOD, stop_reason="max_tokens"), 502, "ai_unavailable"),
        (anthropic_reply(""), 502, "ai_invalid_reply"),
        (anthropic_reply("not json"), 502, "ai_invalid_reply"),
        (httpx.Response(500, json={"error": {"message": LEAK}}), 502, "ai_unavailable"),
        (httpx.Response(429, text=LEAK), 502, "ai_unavailable"),
        (httpx.Response(401, text=LEAK), 502, "ai_unavailable"),
    ],
)
@pytest.mark.parametrize("route", ["/v1/ask", "/v1/day/close"])
async def test_provider_failures_map_to_explicit_responses(
    client, anthropic, caplog, reply, status, code, route
):
    anthropic.mock(return_value=reply)
    body = ask_body() if route == "/v1/ask" else close_body()
    with caplog.at_level(logging.DEBUG):
        response = await client.post(route, json=body, headers=auth())
    assert response.status_code == status
    assert response.json()["errors"] == [{"loc": ["body"], "type": code}]
    text = response.text + caplog.text
    assert LEAK not in text
    assert FAKE_KEY not in text


async def test_a_transport_error_is_a_502(client, anthropic):
    anthropic.mock(side_effect=httpx.ConnectTimeout("slow"))
    response = await client.post("/v1/ask", json=ask_body(), headers=auth())
    assert response.status_code == 502
    assert response.json()["errors"][0]["type"] == "ai_unavailable"


class _WithholdingProvider:
    """Stands for any day a server source could carry raw health (none does yet)."""

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        raise PolicyViolation("raw health samples must never be sent to DeepSeek")


async def test_a_withheld_raw_health_payload_is_still_a_422_without_a_500():
    """M-6: the `raw_health_not_allowed` mapping stays reachable and tested."""
    app = build_app()
    app.state.insights = InsightService(_WithholdingProvider(), app.state.settings)
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        response = await c.post("/v1/ask", json=ask_body(), headers=auth())
    assert response.status_code == 422
    assert response.json() == {
        "detail": "لا تُرسل بيانات صحية خام إلى هذا المزوّد",
        "errors": [{"loc": ["body"], "type": "raw_health_not_allowed"}],
    }


async def test_a_missing_key_is_a_503():
    app = build_app(anthropic_api_key=None)
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        response = await c.post("/v1/ask", json=ask_body(), headers=auth())
    assert response.status_code == 503
    assert response.json()["errors"][0]["type"] == "ai_not_configured"


def deepseek_reply(payload: Any) -> httpx.Response:
    content = json.dumps(payload, ensure_ascii=False)
    choice = {"index": 0, "message": {"role": "assistant", "content": content}}
    return httpx.Response(200, json={"id": "c", "choices": [{**choice, "finish_reason": "stop"}]})


async def test_deepseek_receives_the_server_grounding_without_raw_health():
    """Replaces the client `raw_samples` 422: no client context exists any more, and the
    grounding the server builds never holds raw health samples, even with `send_raw_health`."""
    app = build_app(
        ai_provider="deepseek",
        deepseek_api_key="fake-deepseek-key-not-real",
        send_raw_health=True,
        model_daily="deepseek-chat",
    )
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(DEEPSEEK_URL).mock(return_value=deepseek_reply(GOOD))
        async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            response = await c.post("/v1/ask", json=ask_body(), headers=auth())
    assert response.status_code == 200, response.text
    assert route.call_count == 1
    assert "raw_samples" not in route.calls.last.request.content.decode()


# --- reviews ---------------------------------------------------------------------------------


def seed(app: FastAPI, kind: str, day: str, line: str = "سطر") -> None:
    response = InsightResponse(lines=[line], question=None, source_ids=[], priorities=[])
    row = new_insight(kind, date.fromisoformat(day), "anthropic", "m", "h" * 64, response)  # type: ignore[arg-type]
    app.state.insights_store.rows.append(row)


async def test_reviews_default_to_weekly_newest_first(client, app):
    seed(app, "weekly", "2026-10-25")
    seed(app, "weekly", "2026-11-08")
    seed(app, "evening", "2026-11-09")
    response = await client.get("/v1/reviews", headers=auth())
    assert response.status_code == 200
    items = response.json()["items"]
    assert [i["day"] for i in items] == ["2026-11-08", "2026-10-25"]
    assert {i["kind"] for i in items} == {"weekly"}
    assert set(items[0]) == {
        "id", "kind", "day", "created_at", "lines", "question", "source_ids", "priorities",
        "cards", "days",
    }  # fmt: skip
    assert items[0]["cards"] == []
    assert items[0]["days"] == []


async def test_reviews_filter_by_kind_limit_and_before(client, app):
    for d in ("2026-11-05", "2026-11-06", "2026-11-07"):
        seed(app, "evening", d)
    got = await client.get("/v1/reviews?kind=evening&limit=2", headers=auth())
    assert [i["day"] for i in got.json()["items"]] == ["2026-11-07", "2026-11-06"]
    older = await client.get("/v1/reviews?kind=evening&before=2026-11-07", headers=auth())
    assert [i["day"] for i in older.json()["items"]] == ["2026-11-06", "2026-11-05"]


@pytest.mark.parametrize("query", ["kind=ask", "limit=0", "limit=51", "before=nope"])
async def test_reviews_reject_bad_queries(client, query):
    response = await client.get(f"/v1/reviews?{query}", headers=auth())
    assert response.status_code == 422
    assert response.json()["detail"] == "طلب غير صالح"


async def test_reviews_empty(client):
    response = await client.get("/v1/reviews", headers=auth())
    assert response.json() == {"items": []}


# --- Postgres store (runs only when TEST_DATABASE_URL points at a database with the schema) ---


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL not set")
async def test_postgres_store_first_closure_wins_and_lists():
    from yawmi.ai.store import AsyncpgInsightStore
    from yawmi.db.pool import create_pool

    pool = await create_pool(os.environ["TEST_DATABASE_URL"])
    day = date(2099, 1, 1)
    try:
        await pool.execute("DELETE FROM yawmi.ai_insights WHERE day = $1", day)
        store = AsyncpgInsightStore(pool)
        reply = InsightResponse(lines=["أ"], question=None, source_ids=["s"], priorities=[])
        first = await store.save_closure(new_insight("evening", day, "anthropic", "m", "h", reply))
        second = await store.save_closure(
            new_insight("evening", day, "anthropic", "m", "h2", reply)
        )
        assert second.id == first.id
        assert (await store.get_closure(day)).response == reply  # type: ignore[union-attr]
        assert [r.id for r in await store.list_reviews("evening", 5, date(2099, 1, 2))] == [
            first.id
        ]
        assert await store.list_reviews("evening", 5, day) == []
    finally:
        await pool.execute("DELETE FROM yawmi.ai_insights WHERE day = $1", day)
        await pool.close()


# --- fix round 1: text guard, wording, size caps -------------------------------------------

BAD_TEXTS = [("lone surrogate", "س\ud800س"), ("NUL", "a\x00b")]


def _bad_bodies(text: str) -> list[tuple[dict[str, Any], str]]:
    """The question is the only free text a client still sends (task 18)."""
    return [(ask_body(question=text), "question")]


@pytest.mark.parametrize(("label", "text"), BAD_TEXTS)
async def test_unstorable_text_is_a_422_not_a_500(client, anthropic, label, text):
    route = "/v1/ask"
    route_mock = anthropic.mock(return_value=anthropic_reply(GOOD))
    for body, field in _bad_bodies(text):
        raw = json.dumps(body, ensure_ascii=True).encode()  # ascii escapes carry the surrogate
        response = await client.post(
            route, content=raw, headers={**auth(), "Content-Type": "application/json"}
        )
        assert response.status_code == 422, (label, field, response.text)
        payload = response.json()
        assert payload["detail"] == "طلب غير صالح"
        [error] = payload["errors"]
        assert error["loc"][:2] == ["body", field]
        # pydantic itself rejects a lone surrogate in a plain `str` field (string_unicode)
        assert error["type"] in {"text_invalid", "string_unicode"}
    assert route_mock.call_count == 0


def test_route_messages_are_gender_neutral():
    import shutil
    import subprocess
    from pathlib import Path

    from yawmi.routes.insights import USER_MESSAGES

    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    module = str(Path(__file__).resolve().parents[1] / "eval" / "promptfoo_support.js")
    script = (
        "const m = require(process.argv[1]); let d='';"
        "process.stdin.on('data', x => d += x);"
        "process.stdin.on('end', () => console.log(JSON.stringify("
        "JSON.parse(d).map(t => m.runChecks({lines:[t],question:null,source_ids:[],priorities:[]},"
        "{config:{checks:['no_gendered_forms'],request:{}}})))));"
    )
    messages = sorted(USER_MESSAGES)
    assert len(messages) >= 5
    run = subprocess.run(
        ["node", "-e", script, module],
        input=json.dumps(messages),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    for message, result in zip(messages, json.loads(run.stdout), strict=True):
        assert result["pass"], (message, result)


def _gendered_words() -> list[str]:
    """`GENDERED_WORDS` of the eval support module, read from its source."""
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "eval" / "promptfoo_support.js").read_text(
        encoding="utf-8"
    )
    block = re.search(r"const GENDERED_WORDS = \[(.*?)\];", source, re.DOTALL)
    assert block is not None
    return re.findall(r"'([^']+)'", block.group(1))


_LETTER = "ء-ي"
_DIACRITICS = re.compile("[ً-ِْ-ٰٟـ]")  # shadda kept, as in JS


def _gendered_hit(text: str, words: list[str]) -> str | None:
    """A Python port of `findWord` (same marks, same glued prefixes, whole words only)."""
    plain = _DIACRITICS.sub("", text)
    for word in words:
        bare = _DIACRITICS.sub("", word)
        letters = len(re.sub(f"[^{_LETTER}]", "", bare))
        prefix = "[وف]?" if letters <= 3 else "[وفبلك]?"
        if re.search(f"(?<![{_LETTER}]){prefix}{re.escape(bare)}(?![{_LETTER}])", plain):
            return word
    return None


def test_route_messages_are_gender_neutral_without_node():
    """Runs everywhere, so the check never depends on `node` being installed (M-5(d))."""
    from yawmi.routes.insights import USER_MESSAGES

    words = _gendered_words()
    assert len(words) > 50
    # the port is not vacuous: it finds what the JS check finds
    assert _gendered_hit("تذكّر شرب الماء", words) == "تذكّر"
    assert _gendered_hit("وعليك المتابعة", words) == "عليك"
    assert _gendered_hit("لكن اليوم انتهى", words) is None
    messages = sorted(USER_MESSAGES)
    assert len(messages) >= 5
    for message in messages:
        assert _gendered_hit(message, words) is None, message


async def test_oversized_inputs_are_422(client, anthropic):
    route_mock = anthropic.mock(return_value=anthropic_reply(GOOD))
    cases = [
        ("question", "/v1/ask", ask_body(question="س" * 501), ["body", "question"]),
        ("range", "/v1/ask", ask_body(range="1y"), ["body", "range"]),
        ("context", "/v1/day/close", close_body(context={"k": "x"}), ["body", "context"]),
        ("sources", "/v1/day/close", close_body(sources=[]), ["body", "sources"]),
        ("regenerate", "/v1/day/close", close_body(regenerate="yes"), ["body", "regenerate"]),
    ]
    for label, route, body, loc in cases:
        response = await client.post(route, json=body, headers=auth())
        assert response.status_code == 422, label
        assert response.json()["errors"][0]["loc"] == loc, label
    assert route_mock.call_count == 0


async def test_caps_allow_the_limits_exactly(client, anthropic):
    anthropic.mock(return_value=anthropic_reply(GOOD))
    response = await client.post(
        "/v1/ask", json=ask_body(question="س" * 500, range="cycle"), headers=auth()
    )
    assert response.status_code == 200


async def test_the_question_never_reaches_a_log(client, anthropic, caplog):
    anthropic.mock(return_value=anthropic_reply(GOOD))
    with caplog.at_level(logging.DEBUG):
        await client.post("/v1/ask", json=ask_body(question="سؤال-خاص-فريد"), headers=auth())
    assert "سؤال-خاص-فريد" not in caplog.text
