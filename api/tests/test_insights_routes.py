"""`/v1/day/close`, `/v1/ask`, `/v1/reviews`: auth, validation, provider-error mapping,
idempotent closure. Providers are `respx` mocks; no network, no real key."""

import json
import logging
import os
import re
from collections.abc import AsyncIterator
from datetime import date, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
import respx
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.ai.schema import InsightResponse
from yawmi.ai.store import InMemoryInsightStore, new_insight
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.main import create_app
from yawmi.settings import Settings

SECRET = "test-secret-for-unit-tests-only-0123456789"
FAKE_KEY = "fake-anthropic-key-not-real"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DAY = "2026-11-10"  # "today" in Riyadh under the conftest clock (2026-11-10T12:00Z)

SOURCES = [
    {"id": "habit:water", "kind": "habit", "text": "شرب الماء: 5 من 8 أكواب اليوم"},
    {"id": "sleep:last", "kind": "sleep", "text": "نوم الليلة الماضية: 6.5 ساعات"},
]
GOOD: dict[str, Any] = {
    "lines": ["الماء: 5 من 8 أكواب حتى الآن.", "النوم الليلة الماضية: 6.5 ساعات."],
    "question": None,
    "source_ids": ["habit:water", "sleep:last"],
    "priorities": [{"title": "إكمال أكواب الماء", "source_id": "habit:water"}],
}
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
    app = create_app(settings=make_settings(**overrides), devices=InMemoryDeviceStore())
    app.state.insights_store = InMemoryInsightStore()
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
    return {"day": DAY, "context": {"habits_done": 5}, "sources": SOURCES, **overrides}


def ask_body(**overrides: Any) -> dict[str, Any]:
    return {"day": DAY, "question": "كم كوب ماء شربت؟", "sources": SOURCES, **overrides}


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
    assert body["source_ids"] == ["habit:water", "sleep:last"]
    assert len(body["lines"]) <= 2
    [row] = app.state.insights_store.rows
    assert row.provider == "anthropic"
    assert row.model == "claude-haiku-5-5"
    assert len(row.request_hash) == 64


async def test_close_twice_calls_the_provider_once_and_returns_the_same_row(client, anthropic):
    route = anthropic.mock(return_value=anthropic_reply(GOOD))
    first = await client.post("/v1/day/close", json=close_body(), headers=auth())
    again = await client.post("/v1/day/close", json=close_body(context={"x": 1}), headers=auth())
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    assert route.call_count == 1


async def test_close_for_another_day_is_a_new_closure(client, app, anthropic):
    anthropic.mock(return_value=anthropic_reply(GOOD))
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
    anthropic.mock(return_value=anthropic_reply(GOOD))
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


async def test_close_strips_raw_samples_before_the_provider(client, anthropic):
    route = anthropic.mock(return_value=anthropic_reply(GOOD))
    ctx = {"habits_done": 5, "raw_samples": [{"hr": 61, "t": "2026-11-10T01:00:00Z"}]}
    response = await client.post("/v1/day/close", json=close_body(context=ctx), headers=auth())
    assert response.status_code == 200
    sent = route.calls.last.request.content.decode()
    assert "raw_samples" not in sent
    assert "2026-11-10T01:00:00Z" not in sent


# --- ask -------------------------------------------------------------------------------------


async def test_ask_answers_and_stores_nothing(client, app, anthropic):
    anthropic.mock(return_value=anthropic_reply(GOOD))
    response = await client.post("/v1/ask", json=ask_body(), headers=auth("web"))
    assert response.status_code == 200
    assert response.json() == GOOD
    assert app.state.insights_store.rows == []


@pytest.mark.parametrize("question", ["", "  ", "س" * 501])
async def test_ask_rejects_bad_questions(client, question):
    response = await client.post("/v1/ask", json=ask_body(question=question), headers=auth())
    assert response.status_code == 422
    assert response.json()["detail"] == "طلب غير صالح"


async def test_ask_rejects_too_many_sources(client):
    many = [{"id": f"s{i}", "kind": "k", "text": "t"} for i in range(51)]
    response = await client.post("/v1/ask", json=ask_body(sources=many), headers=auth())
    assert response.status_code == 422


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


async def test_a_missing_key_is_a_503():
    app = build_app(anthropic_api_key=None)
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        response = await c.post("/v1/ask", json=ask_body(), headers=auth())
    assert response.status_code == 503
    assert response.json()["errors"][0]["type"] == "ai_not_configured"


async def test_raw_health_to_deepseek_is_withheld_with_a_422():
    app = build_app(
        ai_provider="deepseek",
        deepseek_api_key="fake-deepseek-key-not-real",
        send_raw_health=True,
        model_daily="deepseek-chat",
    )
    ctx = {"raw_samples": [{"hr": 61}]}
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(DEEPSEEK_URL)
        async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            response = await c.post("/v1/ask", json=ask_body(context=ctx), headers=auth())
    assert response.status_code == 422
    assert response.json()["errors"] == [{"loc": ["body"], "type": "raw_health_not_allowed"}]
    assert route.call_count == 0


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
        "id", "kind", "day", "created_at", "lines", "question", "source_ids", "priorities"
    }  # fmt: skip


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


def _bad_bodies(route: str, text: str) -> list[tuple[dict[str, Any], str]]:
    base = ask_body if route == "/v1/ask" else close_body
    bodies: list[tuple[dict[str, Any], str]] = [
        (base(context={"k": text}), "context"),
        (base(context={text: 1}), "context"),
        (base(sources=[{"id": "a", "kind": "k", "text": text}]), "sources"),
        (base(sources=[{"id": text, "kind": "k", "text": "t"}]), "sources"),
        (base(sources=[{"id": "a", "kind": text, "text": "t"}]), "sources"),
    ]
    if route == "/v1/ask":
        bodies.append((ask_body(question=text), "question"))
    return bodies


@pytest.mark.parametrize("route", ["/v1/ask", "/v1/day/close"])
@pytest.mark.parametrize(("label", "text"), BAD_TEXTS)
async def test_unstorable_text_is_a_422_not_a_500(client, anthropic, route, label, text):
    route_mock = anthropic.mock(return_value=anthropic_reply(GOOD))
    for body, field in _bad_bodies(route, text):
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
        if field == "context":
            assert error["type"] == "text_invalid"
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
        ("context", "/v1/ask", ask_body(context={"k": "x" * 20000}), ["body", "context"]),
        ("context", "/v1/day/close", close_body(context={"k": "x" * 20000}), ["body", "context"]),
        (
            "id",
            "/v1/ask",
            ask_body(sources=[{"id": "i" * 65, "kind": "k", "text": "t"}]),
            ["body", "sources", 0, "id"],
        ),
        (
            "kind",
            "/v1/ask",
            ask_body(sources=[{"id": "i", "kind": "k" * 33, "text": "t"}]),
            ["body", "sources", 0, "kind"],
        ),
        (
            "text",
            "/v1/day/close",
            close_body(sources=[{"id": "i", "kind": "k", "text": "ن" * 501}]),
            ["body", "sources", 0, "text"],
        ),
    ]
    for label, route, body, loc in cases:
        response = await client.post(route, json=body, headers=auth())
        assert response.status_code == 422, label
        assert response.json()["errors"][0]["loc"] == loc, label
    assert route_mock.call_count == 0


async def test_caps_allow_the_limits_exactly(client, anthropic):
    cited = {**GOOD, "source_ids": ["i" * 64], "priorities": []}
    anthropic.mock(return_value=anthropic_reply(cited))
    sources = [{"id": "i" * 64, "kind": "k" * 32, "text": "ن" * 500}] * 50
    response = await client.post(
        "/v1/ask", json=ask_body(sources=sources, question="س" * 500), headers=auth()
    )
    assert response.status_code == 200


async def test_ask_strips_raw_samples_before_the_provider(client, anthropic):
    route = anthropic.mock(return_value=anthropic_reply(GOOD))
    ctx = {"raw_samples": [{"t": "2026-11-10T01:00:00Z"}]}
    response = await client.post("/v1/ask", json=ask_body(context=ctx), headers=auth())
    assert response.status_code == 200
    assert "raw_samples" not in route.calls.last.request.content.decode()


async def test_the_question_never_reaches_a_log(client, anthropic, caplog):
    anthropic.mock(return_value=anthropic_reply(GOOD))
    with caplog.at_level(logging.DEBUG):
        await client.post("/v1/ask", json=ask_body(question="سؤال-خاص-فريد"), headers=auth())
    assert "سؤال-خاص-فريد" not in caplog.text
