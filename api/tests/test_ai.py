"""AI adapter tests: schema, both providers (respx mocks only), the grounded service, eval set.

No test here touches the network or a real key: every HTTP call is a `respx` route and every key
is an obviously fake placeholder.
"""

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from pydantic import SecretStr, ValidationError

from yawmi.ai.anthropic import AnthropicProvider
from yawmi.ai.base import (
    PolicyViolation,
    Provider,
    ProviderEmpty,
    ProviderError,
    ProviderMalformed,
    ProviderNotConfigured,
    ProviderRefusal,
)
from yawmi.ai.deepseek import DeepSeekProvider
from yawmi.ai.schema import InsightRequest, InsightResponse, Source, insight_json_schema
from yawmi.ai.service import (
    InsightInvalid,
    InsightService,
    build_provider,
    canonical_json,
    load_system_prompt,
    request_hash,
    strip_raw_samples,
)
from yawmi.settings import Settings

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
FAKE_KEY = "fake-anthropic-key-not-real"
FAKE_DEEPSEEK_KEY = "fake-deepseek-key-not-real"

API_DIR = Path(__file__).resolve().parent.parent
EVAL_DIR = API_DIR / "eval"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drop any YAWMI_* variables inherited from the shell so tests are hermetic."""
    for key in list(os.environ):
        if key.startswith("YAWMI_"):
            monkeypatch.delenv(key, raising=False)


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "database_url": "postgresql://yawmi_api@localhost:5432/raqib",
        "jwt_secret": "test-secret",
        "anthropic_api_key": FAKE_KEY,
        "deepseek_api_key": FAKE_DEEPSEEK_KEY,
        **overrides,
    }
    return Settings(**values)


SOURCES = [
    Source(id="habit:water", kind="habit", text="شرب الماء: 5 من 8 أكواب اليوم"),
    Source(id="sleep:last", kind="sleep", text="نوم الليلة الماضية: 6.5 ساعات"),
]


def make_request(kind: str = "morning", **overrides: Any) -> InsightRequest:
    values: dict[str, Any] = {
        "kind": kind,
        "day": date(2026, 11, 10),
        "context": {"habits_done": 5, "habits_target": 8},
        "sources": SOURCES,
    }
    if kind == "ask":
        values["question"] = "كم كوب ماء شربت اليوم؟"
    values.update(overrides)
    return InsightRequest(**values)


GOOD: dict[str, Any] = {
    "lines": ["الماء: 5 من 8 أكواب حتى الآن.", "النوم الليلة الماضية: 6.5 ساعات."],
    "question": None,
    "source_ids": ["habit:water", "sleep:last"],
    "priorities": [{"title": "إكمال أكواب الماء", "source_id": "habit:water"}],
}


def with_(**changes: Any) -> dict[str, Any]:
    return {**GOOD, **changes}


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


def deepseek_reply(content: str | None, finish_reason: str = "stop") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-test",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": finish_reason,
                }
            ],
        },
    )


class FakeProvider:
    """Scripted provider: returns (or raises) the next scripted item per call."""

    def __init__(self, *script: Any, name: str | None = None) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []
        if name is not None:
            self.name = name

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        self.calls.append({"system": system, "user": user, "schema": schema, "model": model})
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def walk(node: Any):
    """Yield every dict node of a nested JSON structure."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)


# --------------------------------------------------------------------------- schema


def test_schema_is_lowest_common_denominator() -> None:
    schema = insight_json_schema()
    assert "$ref" not in json.dumps(schema)
    assert "$defs" not in schema
    keywords = {"minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "default"}
    for node in walk(schema):
        if "properties" in node:
            # property *names* may legitimately collide with keywords (e.g. "title"): skip them
            assert node["additionalProperties"] is False
            assert node["required"] == list(node["properties"])
            assert not keywords & (set(node) - {"properties"})
            for sub in node["properties"].values():
                assert not keywords & set(sub)
        else:
            assert not keywords & set(node)


def test_schema_shape() -> None:
    schema = insight_json_schema()
    assert schema["type"] == "object"
    assert set(schema["properties"]) == {"lines", "question", "source_ids", "priorities"}
    assert set(schema["required"]) == {"lines", "question", "source_ids", "priorities"}
    assert schema["properties"]["lines"]["type"] == "array"
    priority = schema["properties"]["priorities"]["items"]
    assert priority["type"] == "object"
    assert set(priority["properties"]) == {"title", "source_id"}
    assert set(priority["required"]) == {"title", "source_id"}
    assert priority["additionalProperties"] is False


def test_schema_is_a_fresh_copy_each_call() -> None:
    first = insight_json_schema()
    first["properties"].clear()
    assert insight_json_schema()["properties"]


def test_response_model_forbids_extra_and_over_long_lines() -> None:
    assert InsightResponse.model_validate(GOOD).lines == GOOD["lines"]
    with pytest.raises(ValidationError):
        InsightResponse.model_validate({**GOOD, "mood": "ok"})
    with pytest.raises(ValidationError):
        InsightResponse.model_validate(with_(lines=["أ", "ب", "ج"]))
    with pytest.raises(ValidationError):
        InsightResponse.model_validate({k: v for k, v in GOOD.items() if k != "question"})


def test_request_kinds_and_ask_needs_a_question() -> None:
    assert make_request("weekly").locale == "ar"
    with pytest.raises(ValidationError):
        InsightRequest(kind="monthly", day=date(2026, 11, 10))
    with pytest.raises(ValidationError):
        InsightRequest(kind="ask", day=date(2026, 11, 10))


# -------------------------------------------------------------------- anthropic provider


@respx.mock
async def test_anthropic_sends_structured_output_request() -> None:
    schema = insight_json_schema()
    route = respx.post(ANTHROPIC_URL).mock(return_value=anthropic_reply(GOOD))
    out = await AnthropicProvider(FAKE_KEY).complete("نظام", "مستخدم", schema, "claude-haiku-5-5")

    assert out == GOOD
    request = route.calls.last.request
    assert request.headers["x-api-key"] == FAKE_KEY
    assert request.headers["anthropic-version"] == "2023-06-01"
    body = json.loads(request.content)
    assert body["model"] == "claude-haiku-5-5"
    assert body["system"] == "نظام"
    assert body["messages"] == [{"role": "user", "content": "مستخدم"}]
    assert isinstance(body["max_tokens"], int) and body["max_tokens"] > 0
    assert body["output_config"] == {"format": {"type": "json_schema", "schema": schema}}
    assert "response_format" not in body
    # 30 s timeout on every phase, no retries (exactly one request was made).
    assert set(request.extensions["timeout"].values()) == {30.0}
    assert route.call_count == 1


@respx.mock
async def test_anthropic_accepts_secretstr_key() -> None:
    route = respx.post(ANTHROPIC_URL).mock(return_value=anthropic_reply(GOOD))
    await AnthropicProvider(SecretStr(FAKE_KEY)).complete("s", "u", {}, "m")
    assert route.calls.last.request.headers["x-api-key"] == FAKE_KEY


@respx.mock
async def test_anthropic_refusal_raises_provider_refusal() -> None:
    respx.post(ANTHROPIC_URL).mock(return_value=anthropic_reply("{}", stop_reason="refusal"))
    with pytest.raises(ProviderRefusal):
        await AnthropicProvider(FAKE_KEY).complete("s", "u", {}, "m")


@respx.mock
async def test_anthropic_max_tokens_is_a_provider_error() -> None:
    respx.post(ANTHROPIC_URL).mock(return_value=anthropic_reply('{"lines":', "max_tokens"))
    with pytest.raises(ProviderError, match="max_tokens"):
        await AnthropicProvider(FAKE_KEY).complete("s", "u", {}, "m")


@respx.mock
async def test_anthropic_http_error_never_leaks_the_key_or_body() -> None:
    respx.post(ANTHROPIC_URL).mock(
        return_value=httpx.Response(
            401, json={"type": "error", "error": {"type": "authentication_error", "message": "x"}}
        )
    )
    with pytest.raises(ProviderError) as exc:
        await AnthropicProvider(FAKE_KEY).complete("سري", "سري", {}, "m")
    assert "401" in str(exc.value)
    assert FAKE_KEY not in str(exc.value) and "سري" not in str(exc.value)


@respx.mock
async def test_anthropic_transport_failure_is_a_provider_error() -> None:
    route = respx.post(ANTHROPIC_URL).mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(ProviderError):
        await AnthropicProvider(FAKE_KEY).complete("s", "u", {}, "m")
    assert route.call_count == 1  # no retry inside the provider


@respx.mock
async def test_anthropic_blank_or_missing_text_is_empty() -> None:
    respx.post(ANTHROPIC_URL).mock(
        side_effect=[
            anthropic_reply("   "),
            httpx.Response(200, json={"content": [], "stop_reason": "end_turn"}),
        ]
    )
    provider = AnthropicProvider(FAKE_KEY)
    with pytest.raises(ProviderEmpty):
        await provider.complete("s", "u", {}, "m")
    with pytest.raises(ProviderEmpty):
        await provider.complete("s", "u", {}, "m")


@respx.mock
async def test_anthropic_non_json_text_is_malformed() -> None:
    respx.post(ANTHROPIC_URL).mock(
        side_effect=[anthropic_reply("هذا ليس JSON"), anthropic_reply("[1, 2]")]
    )
    provider = AnthropicProvider(FAKE_KEY)
    with pytest.raises(ProviderMalformed):
        await provider.complete("s", "u", {}, "m")
    with pytest.raises(ProviderMalformed):
        await provider.complete("s", "u", {}, "m")


def test_provider_protocol_is_satisfied_by_both_adapters() -> None:
    providers: list[Provider] = [AnthropicProvider(FAKE_KEY), DeepSeekProvider(FAKE_DEEPSEEK_KEY)]
    assert [p.name for p in providers] == ["anthropic", "deepseek"]  # type: ignore[attr-defined]


# --------------------------------------------------------------------- deepseek provider


@respx.mock
async def test_deepseek_sends_json_object_with_schema_in_system_prompt() -> None:
    schema = insight_json_schema()
    route = respx.post(DEEPSEEK_URL).mock(
        return_value=deepseek_reply(json.dumps(GOOD, ensure_ascii=False))
    )
    provider = DeepSeekProvider(FAKE_DEEPSEEK_KEY)
    out = await provider.complete("نظام", "مستخدم", schema, "deepseek-chat")

    assert out == GOOD
    request = route.calls.last.request
    assert request.headers["authorization"] == f"Bearer {FAKE_DEEPSEEK_KEY}"
    body = json.loads(request.content)
    assert body["model"] == "deepseek-chat"
    assert body["response_format"] == {"type": "json_object"}
    system, user = body["messages"]
    assert system["role"] == "system" and system["content"].startswith("نظام")
    assert json.dumps(schema, ensure_ascii=False) in system["content"]
    assert "JSON" in system["content"]  # json_object mode requires the word in the prompt
    assert user == {"role": "user", "content": "مستخدم"}
    assert set(request.extensions["timeout"].values()) == {30.0}


@respx.mock
async def test_deepseek_empty_content_raises_provider_empty() -> None:
    respx.post(DEEPSEEK_URL).mock(side_effect=[deepseek_reply(""), deepseek_reply(None)])
    provider = DeepSeekProvider(FAKE_DEEPSEEK_KEY)
    with pytest.raises(ProviderEmpty):
        await provider.complete("s", "u", {}, "m")
    with pytest.raises(ProviderEmpty):
        await provider.complete("s", "u", {}, "m")


@respx.mock
async def test_deepseek_truncation_content_filter_and_http_errors() -> None:
    respx.post(DEEPSEEK_URL).mock(
        side_effect=[
            deepseek_reply('{"lines":', "length"),
            deepseek_reply("{}", "content_filter"),
            httpx.Response(500, text="boom"),
            deepseek_reply("ليس JSON"),
        ]
    )
    provider = DeepSeekProvider(FAKE_DEEPSEEK_KEY)
    with pytest.raises(ProviderError, match="length"):
        await provider.complete("s", "u", {}, "m")
    with pytest.raises(ProviderRefusal):
        await provider.complete("s", "u", {}, "m")
    with pytest.raises(ProviderError, match="500"):
        await provider.complete("s", "u", {}, "m")
    with pytest.raises(ProviderMalformed):
        await provider.complete("s", "u", {}, "m")


@respx.mock
async def test_deepseek_never_sends_raw_samples_even_when_called_directly() -> None:
    route = respx.post(DEEPSEEK_URL).mock(return_value=deepseek_reply("{}"))
    user = json.dumps({"context": {"raw_samples": [1, 2, 3]}})
    with pytest.raises(PolicyViolation):
        await DeepSeekProvider(FAKE_DEEPSEEK_KEY).complete("s", user, {}, "m")
    assert route.call_count == 0


# ------------------------------------------------------------------------------ service


async def test_valid_response_passes_on_the_first_call() -> None:
    provider = FakeProvider(GOOD)
    out = await InsightService(provider, make_settings()).generate(make_request())

    assert isinstance(out, InsightResponse)
    assert out.lines == GOOD["lines"]
    assert len(provider.calls) == 1
    call = provider.calls[0]
    assert call["schema"] == insight_json_schema()
    assert call["system"] == load_system_prompt()
    sent = json.loads(call["user"])
    assert sent["kind"] == "morning" and sent["day"] == "2026-11-10"
    assert [s["id"] for s in sent["sources"]] == ["habit:water", "sleep:last"]


@pytest.mark.parametrize(
    ("kind", "model"),
    [
        ("morning", "m-daily"),
        ("evening", "m-daily"),
        ("ask", "m-daily"),
        ("weekly", "m-weekly"),
    ],
)
async def test_model_choice_by_kind(kind: str, model: str) -> None:
    provider = FakeProvider(GOOD)
    settings = make_settings(model_daily="m-daily", model_weekly="m-weekly")
    await InsightService(provider, settings).generate(make_request(kind))
    assert provider.calls[0]["model"] == model


async def test_default_models_follow_settings_defaults() -> None:
    provider = FakeProvider(GOOD, GOOD)
    service = InsightService(provider, make_settings())
    await service.generate(make_request("morning"))
    await service.generate(make_request("weekly"))
    assert [c["model"] for c in provider.calls] == ["claude-haiku-5-5", "claude-sonnet-5-5"]


@respx.mock
async def test_fabricated_source_id_calls_the_provider_twice_then_fails() -> None:
    route = respx.post(ANTHROPIC_URL).mock(return_value=anthropic_reply(with_(source_ids=["X"])))
    service = InsightService(AnthropicProvider(FAKE_KEY), make_settings())

    with pytest.raises(InsightInvalid) as exc:
        await service.generate(make_request())

    assert route.call_count == 2
    assert "unknown_source" in exc.value.reasons
    first_user = json.loads(route.calls[0].request.content)["messages"][0]["content"]
    second_user = json.loads(route.calls[1].request.content)["messages"][0]["content"]
    assert second_user.startswith(first_user) and len(second_user) > len(first_user)
    assert "habit:water" in second_user.removeprefix(first_user)  # allowed ids are restated


@respx.mock
async def test_three_lines_are_repaired_on_the_second_call() -> None:
    route = respx.post(ANTHROPIC_URL).mock(
        side_effect=[
            anthropic_reply(with_(lines=["أ", "ب", "ج"])),
            anthropic_reply(GOOD),
        ]
    )
    service = InsightService(AnthropicProvider(FAKE_KEY), make_settings())

    out = await service.generate(make_request())

    assert out.lines == GOOD["lines"]
    assert route.call_count == 2


async def test_priority_source_outside_the_payload_is_rejected() -> None:
    bad = with_(priorities=[{"title": "إنجاز", "source_id": "goal:ghost"}])
    provider = FakeProvider(bad, bad)
    with pytest.raises(InsightInvalid) as exc:
        await InsightService(provider, make_settings()).generate(make_request())
    assert len(provider.calls) == 2
    assert exc.value.reasons == ["unknown_source"]


async def test_extra_keys_and_missing_keys_are_rejected_then_repaired() -> None:
    provider = FakeProvider({**GOOD, "mood": "جيد"}, {"lines": ["س"]}, GOOD)
    service = InsightService(provider, make_settings())
    with pytest.raises(InsightInvalid) as exc:
        await service.generate(make_request())
    assert exc.value.reasons == ["schema"]
    assert len(provider.calls) == 2
    # the third scripted item is untouched; a new request starts a fresh attempt budget
    assert (await service.generate(make_request())).lines == GOOD["lines"]


async def test_empty_or_malformed_reply_is_retried_once() -> None:
    provider = FakeProvider(ProviderEmpty("empty"), GOOD)
    out = await InsightService(provider, make_settings()).generate(make_request())
    assert out.lines == GOOD["lines"] and len(provider.calls) == 2

    provider = FakeProvider(ProviderMalformed("bad"), ProviderEmpty("empty"))
    with pytest.raises(InsightInvalid) as exc:
        await InsightService(provider, make_settings()).generate(make_request())
    assert exc.value.reasons == ["empty"]


@pytest.mark.parametrize("error", [ProviderRefusal("no"), ProviderError("down")])
async def test_refusal_and_transport_errors_are_not_retried(error: ProviderError) -> None:
    provider = FakeProvider(error, GOOD)
    with pytest.raises(type(error)):
        await InsightService(provider, make_settings()).generate(make_request())
    assert len(provider.calls) == 1


async def test_no_sources_means_empty_citations_are_valid() -> None:
    empty = {"lines": ["لا بيانات كافية."], "question": None, "source_ids": [], "priorities": []}
    out = await InsightService(FakeProvider(empty), make_settings()).generate(
        make_request("ask", sources=[], context={})
    )
    assert out.source_ids == [] and out.priorities == []


# -------------------------------------------------------------------- health data policy


def test_strip_raw_samples_is_recursive_and_pure() -> None:
    value = {"a": {"raw_samples": [1], "b": [{"raw_samples": 2, "c": 3}]}, "raw_samples": 4}
    assert strip_raw_samples(value) == {"a": {"b": [{"c": 3}]}}
    assert "raw_samples" in value  # input untouched


@respx.mock
async def test_raw_samples_are_stripped_when_not_allowed() -> None:
    route = respx.post(ANTHROPIC_URL).mock(return_value=anthropic_reply(GOOD))
    request = make_request(context={"steps": 4200, "raw_samples": [{"hr": 71234}]})
    service = InsightService(AnthropicProvider(FAKE_KEY), make_settings(send_raw_health=False))

    await service.generate(request)

    sent = route.calls.last.request.content.decode()
    assert "raw_samples" not in sent and "71234" not in sent
    assert "4200" in sent


@respx.mock
async def test_deepseek_with_raw_health_enabled_violates_policy_before_any_call() -> None:
    route = respx.post(DEEPSEEK_URL).mock(return_value=deepseek_reply("{}"))
    request = make_request(context={"raw_samples": [{"hr": 71}]})
    provider = DeepSeekProvider(FAKE_DEEPSEEK_KEY)
    service = InsightService(provider, make_settings(send_raw_health=True))

    with pytest.raises(PolicyViolation):
        await service.generate(request)

    assert route.call_count == 0


@respx.mock
async def test_deepseek_without_raw_health_gets_stripped_payload() -> None:
    route = respx.post(DEEPSEEK_URL).mock(
        return_value=deepseek_reply(json.dumps(GOOD, ensure_ascii=False))
    )
    request = make_request(context={"steps": 4200, "raw_samples": [{"hr": 71234}]})
    service = InsightService(DeepSeekProvider(FAKE_DEEPSEEK_KEY), make_settings())

    await service.generate(request)

    assert "raw_samples" not in route.calls.last.request.content.decode()


@respx.mock
async def test_anthropic_with_raw_health_enabled_keeps_raw_samples() -> None:
    route = respx.post(ANTHROPIC_URL).mock(return_value=anthropic_reply(GOOD))
    request = make_request(context={"raw_samples": [{"hr": 71234}]})
    service = InsightService(AnthropicProvider(FAKE_KEY), make_settings(send_raw_health=True))

    await service.generate(request)

    assert "71234" in route.calls.last.request.content.decode()


async def test_deepseek_selected_in_settings_also_counts_as_deepseek() -> None:
    settings = make_settings(send_raw_health=True, ai_provider="deepseek")
    provider = FakeProvider(GOOD)
    with pytest.raises(PolicyViolation):
        await InsightService(provider, settings).generate(
            make_request(context={"raw_samples": [1]})
        )
    assert provider.calls == []


# ----------------------------------------------------------------------------- logging


async def test_service_logs_only_the_request_hash(caplog: pytest.LogCaptureFixture) -> None:
    secret_note = "ملاحظة-سرية-للاختبار-123"
    secret_question = "سؤال-سري-للاختبار-456"
    reply_line = "سطر-رد-سري-789"
    request = make_request("ask", context={"note": secret_note}, question=secret_question)
    provider = FakeProvider(with_(lines=[reply_line]))
    caplog.set_level(logging.DEBUG)

    await InsightService(provider, make_settings()).generate(request)

    expected = request_hash(json.loads(provider.calls[0]["user"]))
    assert f"request_hash={expected}" in caplog.text
    assert re.fullmatch(r"[0-9a-f]{64}", expected)
    for secret in (secret_note, secret_question, reply_line, "habit:water", "شرب الماء"):
        assert secret not in caplog.text


async def test_failure_logs_also_carry_no_bodies(caplog: pytest.LogCaptureFixture) -> None:
    bad = with_(source_ids=["ghost-id-777"], lines=["سطر-فاشل-سري"])
    caplog.set_level(logging.DEBUG)
    with pytest.raises(InsightInvalid):
        await InsightService(FakeProvider(bad, bad), make_settings()).generate(
            make_request("ask", question="سؤال-سري-للاختبار-456")
        )
    assert "request_hash=" in caplog.text
    for secret in ("ghost-id-777", "سطر-فاشل-سري", "سؤال-سري-للاختبار-456"):
        assert secret not in caplog.text


def test_request_hash_is_canonical_and_order_independent() -> None:
    a = {"b": 1, "a": {"y": [1, 2], "x": "س"}}
    b = {"a": {"x": "س", "y": [1, 2]}, "b": 1}
    assert request_hash(a) == request_hash(b)
    assert canonical_json(a) == '{"a":{"x":"س","y":[1,2]},"b":1}'
    assert request_hash(a) == hashlib.sha256(canonical_json(a).encode()).hexdigest()
    assert request_hash(a) != request_hash({**a, "b": 2})


# ------------------------------------------------------------------- provider selection


def test_build_provider_follows_settings() -> None:
    assert isinstance(build_provider(make_settings()), AnthropicProvider)
    assert isinstance(build_provider(make_settings(ai_provider="deepseek")), DeepSeekProvider)
    with pytest.raises(ProviderNotConfigured):
        build_provider(make_settings(anthropic_api_key=None))
    with pytest.raises(ProviderNotConfigured):
        build_provider(make_settings(ai_provider="deepseek", deepseek_api_key=None))


def test_exception_hierarchy() -> None:
    assert issubclass(ProviderNotConfigured, ProviderError)
    assert issubclass(ProviderRefusal, ProviderError)
    assert issubclass(ProviderEmpty, ProviderError)
    assert issubclass(ProviderMalformed, ProviderError)
    assert not issubclass(PolicyViolation, ProviderError)


# ---------------------------------------------------------------------- system prompt


def prompt_json_blocks() -> list[Any]:
    return [
        json.loads(m) for m in re.findall(r"```json\n(.*?)\n```", load_system_prompt(), re.DOTALL)
    ]


def test_system_prompt_carries_the_binding_rules() -> None:
    text = load_system_prompt()
    for needle in ("JSON", "سطران", "لا بيانات كافية", "معرّف", "الأرقام", "تشخيص"):
        assert needle in text, needle
    assert "{{" not in text and "{%" not in text and "{#" not in text  # safe inside promptfoo too


def test_system_prompt_few_shots_obey_their_own_contract() -> None:
    blocks = prompt_json_blocks()
    assert len(blocks) == 4  # two examples, each an input then an output
    for request_block, response_block in zip(blocks[0::2], blocks[1::2], strict=True):
        request = InsightRequest.model_validate(request_block)
        response = InsightResponse.model_validate(response_block)
        allowed = {s.id for s in request.sources}
        assert set(response.source_ids) <= allowed
        assert {p.source_id for p in response.priorities} <= allowed
        assert len(response.lines) <= 2


def test_system_prompt_addresses_no_gender() -> None:
    letters = "ء-ي"
    banned = ["أنت", "عليك", "لك", "لديك", "قم", "افعل", "فعّل", "اشرب", "ابدأ"]
    # the prompt may *name* a banned form, but only inside « » quotes in its prohibition rule
    outside_quotes = re.sub(r"«[^»]*»", "", load_system_prompt())
    for word in banned:
        assert not re.search(rf"(?<![{letters}]){word}(?![{letters}])", outside_quotes), word


# ------------------------------------------------------------------------------- eval set


def load_cases() -> list[dict[str, Any]]:
    path = EVAL_DIR / "cases.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def check_names(case: dict[str, Any]) -> set[str]:
    return {m if isinstance(m, str) else m["check"] for m in case["must_pass"]}


def test_eval_set_has_thirty_well_formed_cases() -> None:
    cases = load_cases()
    assert len(cases) == 30
    assert len({c["id"] for c in cases}) == 30
    assert {c["kind"] for c in cases} == {"morning", "evening", "weekly", "ask"}
    for case in cases:
        request = InsightRequest(
            kind=case["kind"],
            day=date(2026, 11, 10),
            context=case["context"],
            sources=[Source.model_validate(s) for s in case["sources"]],
            question=case.get("question"),
        )
        assert request.kind == case["kind"]
        assert case["must_pass"], case["id"]
        assert len({s["id"] for s in case["sources"]}) == len(case["sources"]), case["id"]


def test_eval_set_covers_the_required_behaviours() -> None:
    cases = load_cases()
    names = set().union(*(check_names(c) for c in cases))
    required = {
        "json_valid",
        "max_two_lines",
        "no_greeting",
        "no_closing_offer",
        "no_gendered_forms",
        "numbers_in_context",
        "no_fabricated_source_id",
        "refuses_advice",
        "arabic_only",
        "no_data_honest",
    }
    assert required <= names
    assert sum(1 for c in cases if c["kind"] == "weekly") >= 4
    assert any(c["kind"] == "ask" and not c["sources"] for c in cases)
    assert sum(1 for c in cases if "refuses_advice" in check_names(c)) >= 3


def test_eval_files_reference_env_var_names_only() -> None:
    key_shape = re.compile("s" + "k-[A-Za-z0-9_-]{8,}")  # split so this file holds no key shape
    config = (EVAL_DIR / "promptfooconfig.yaml").read_text(encoding="utf-8")
    assert "ANTHROPIC_API_KEY" in config
    for name in ("promptfooconfig.yaml", "cases.jsonl", "promptfoo_support.js"):
        text = (EVAL_DIR / name).read_text(encoding="utf-8")
        assert not key_shape.search(text), name
        assert not re.search(r"apiKey:\s*\S", text), name


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_eval_assertions_accept_good_and_reject_bad_outputs() -> None:
    """Drive the promptfoo assertion module with canned outputs (offline, no model)."""
    script = (
        "const m = require(process.argv[1]);"
        "let data = '';"
        "process.stdin.on('data', d => data += d);"
        "process.stdin.on('end', () => {"
        "  const cases = JSON.parse(data);"
        "  console.log(JSON.stringify(cases.map(c => m.runChecks(c.output, c.context))));"
        "});"
    )
    module = str(EVAL_DIR / "promptfoo_support.js")
    probe = next(c for c in load_cases() if c["kind"] == "morning" and c["sources"])
    checks = [
        "json_valid",
        "max_two_lines",
        "at_most_one_question",
        "no_greeting",
        "no_closing_offer",
        "no_gendered_forms",
        "no_preaching",
        "no_flattery",
        "numbers_in_context",
        "no_fabricated_source_id",
        "cites_a_source",
        "arabic_only",
    ]
    context = {
        "config": {
            "checks": checks,
            "request": {
                "context": probe["context"],
                "sources": probe["sources"],
                "question": probe.get("question"),
            },
        }
    }
    cited = probe["sources"][0]
    good = {
        "lines": [cited["text"], "المتابعة مستمرة."],
        "question": None,
        "source_ids": [cited["id"]],
        "priorities": [],
    }

    def variant(**changes: Any) -> str:
        return json.dumps({**good, **changes}, ensure_ascii=False)

    def sc(
        output: str,
        expected: bool,
        only: list[str] | None = None,
        request: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        config = {**context["config"], "checks": only or checks}
        if request is not None:
            config["request"] = request
        return {"output": output, "expected": expected, "context": {"config": config}}

    gender = ["no_gendered_forms"]
    numbers = ["numbers_in_context"]
    value_only_request = {
        "context": {"sleep_avg_7d": 6.8, "streak_14d": 3},
        "sources": [{"id": "s:1", "kind": "sleep", "text": "النوم: 6.8 ساعات"}],
    }

    scenarios: list[dict[str, Any]] = [
        sc(variant(), True),
        sc("ليس JSON", False),
        sc(variant(lines=["أ", "ب", "ج"]), False),
        sc(variant(lines=["مرحباً بك، هذا ملخص اليوم."]), False),
        sc(variant(lines=["الخلاصة جاهزة. هل تريد المزيد؟"]), False),
        sc(variant(lines=["قم بإكمال المهام."]), False),
        sc(variant(lines=["أنتَ متأخر عن الخطة."]), False),
        sc(variant(lines=["يجب أن يكتمل الهدف اليوم."]), False),
        sc(variant(lines=["أحسنت، أُنجزت المهام."]), False),
        sc(variant(question="هل نمت جيداً؟", lines=["ما الجديد؟", "لا جديد."]), False),
        sc(variant(priorities=[{"title": "هدف", "source_id": "ghost:2"}]), False),
        sc(variant(lines=["تم إنجاز 987654 مهمة."]), False),
        sc(variant(source_ids=["ghost:1"]), False),
        sc(variant(source_ids=[]), False),
        sc(variant(lines=["Great progress today."]), False),
    ]

    # Imperatives glued to a conjunction/preposition prefix, and the wider imperative list.
    for phrase in (
        "وقم بإكمال المهام.",
        "فاحرص على النوم المبكر.",
        "وتذكر موعد الغد.",
        "جرّب المشي صباحاً.",
        "راجع الأهداف.",
        "سجّل العادات.",
        "حافظ على الروتين.",
        "استمر في القراءة.",
        "خصّص وقتاً للمراجعة.",
        "فكّر في الأولويات.",
        "توقف عن السهر.",
        "اكتب الملاحظات.",
        "نم مبكراً.",
        "أكمل الجلسة.",
        "ابدأ اليوم بالمشي.",
        "ولا تنس الموعد.",
    ):
        scenarios.append(sc(variant(lines=[phrase]), False, only=gender))
    # Neutral phrasing must pass, including "لكن" (which contains "كن") and a verbatim quote.
    for phrase in (
        "يُستحسن إكمال المهام.",
        "الاستمرار على النوم المبكر.",
        "لكن المتوسط أقل من الهدف.",
        "ولكن الأرقام ثابتة.",
        "السبب العميق: «كن صبوراً مع أسرتي».",
        "المراجعة اليومية مكتملة، والسجل محدّث.",
    ):
        scenarios.append(sc(variant(lines=[phrase]), True, only=gender))

    # Allowed numbers come from the request's VALUES, never from its key names.
    def numeric(line: str, expected: bool) -> dict[str, Any]:
        return sc(variant(lines=[line]), expected, only=numbers, request=value_only_request)

    scenarios += [
        numeric("النوم 7 ساعات.", False),  # the 7 exists only inside the key `sleep_avg_7d`
        numeric("النوم 14 يوماً.", False),  # the 14 exists only inside the key `streak_14d`
        numeric("النوم 6.8 ساعات.", True),
        numeric("السلسلة 3 أيام.", True),
    ]

    run = subprocess.run(
        ["node", "-e", script, module],
        input=json.dumps([{"output": x["output"], "context": x["context"]} for x in scenarios]),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    results = json.loads(run.stdout)
    for scenario, result in zip(scenarios, results, strict=True):
        assert result["pass"] is scenario["expected"], (scenario["output"], result)
