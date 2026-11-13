"""`/v1/ai/consent` and the consent gate of the AI routes (design §10, §7.1, §7.6).

No provider is called without a standing consent for the configured provider (`ai_provider`):
the AI routes answer 403 `ai_consent_required`. A withdrawal sets `revoked_at` (the row stays),
and a new consent for the same provider clears it in the same row.
"""

from typing import Any

import httpx
import pytest
from ai_harness import DAY, AiBackend, auth

from yawmi.ai.consent import MSG_CONSENT_REQUIRED, MSG_PROVIDER_MISMATCH

AI_CALLS = [
    ("/v1/day/close", {"day": DAY.isoformat()}),
    ("/v1/ask", {"question": "كيف كان اليوم؟"}),
]


@pytest.fixture
def client(ai_client: httpx.AsyncClient) -> httpx.AsyncClient:
    return ai_client


async def put(client: httpx.AsyncClient, provider: str = "anthropic", personal: bool = False):
    body = {"provider": provider, "personal_text": personal}
    return await client.put("/v1/ai/consent", json=body, headers=auth())


def assert_consent_required(resp: httpx.Response) -> None:
    assert resp.status_code == 403, resp.text
    assert resp.json() == {
        "detail": MSG_CONSENT_REQUIRED,
        "errors": [{"loc": ["body"], "type": "ai_consent_required"}],
    }


@pytest.mark.parametrize(("path", "body"), AI_CALLS)
async def test_without_consent_the_ai_routes_are_403_and_the_provider_is_not_called(
    ai: AiBackend, client: httpx.AsyncClient, path: str, body: dict[str, Any]
) -> None:
    assert_consent_required(await client.post(path, json=body, headers=auth()))
    assert ai.provider.calls == []


async def test_consent_for_another_provider_is_a_409(
    ai: AiBackend, client: httpx.AsyncClient
) -> None:
    resp = await put(client, "deepseek")
    assert resp.status_code == 409
    assert resp.json() == {
        "detail": MSG_PROVIDER_MISMATCH,
        "errors": [{"loc": ["body", "provider"], "type": "provider_mismatch"}],
    }
    assert await ai.consent_row("deepseek") is None


@pytest.mark.parametrize("body", [{"provider": "openai"}, {"personal_text": True}, {}])
async def test_a_bad_consent_body_is_a_422(client: httpx.AsyncClient, body: dict[str, Any]) -> None:
    resp = await client.put("/v1/ai/consent", json=body, headers=auth())
    assert resp.status_code == 422


@pytest.mark.parametrize(("path", "body"), AI_CALLS)
async def test_changing_the_provider_drops_the_consent(
    ai: AiBackend, client: httpx.AsyncClient, path: str, body: dict[str, Any]
) -> None:
    assert (await put(client)).status_code == 200
    assert (await client.post(path, json=body, headers=auth())).status_code == 200
    app = client.app  # type: ignore[attr-defined]
    app.state.settings = app.state.settings.model_copy(update={"ai_provider": "deepseek"})
    assert_consent_required(await client.post(path, json=body, headers=auth()))
    assert len(ai.provider.calls) == 1
    got = await client.get("/v1/ai/consent", headers=auth())
    assert got.json() == {
        "provider": "deepseek",
        "granted": False,
        "personal_text": False,
        "granted_at": None,
    }


async def test_get_reports_the_grant_and_personal_text(client: httpx.AsyncClient) -> None:
    empty = await client.get("/v1/ai/consent", headers=auth())
    assert empty.status_code == 200
    assert empty.json() == {
        "provider": "anthropic",
        "granted": False,
        "personal_text": False,
        "granted_at": None,
    }
    granted = await put(client, personal=True)
    assert granted.status_code == 200
    body = (await client.get("/v1/ai/consent", headers=auth())).json()
    assert body == granted.json()
    assert body["provider"] == "anthropic"
    assert body["granted"] is True
    assert body["personal_text"] is True
    assert body["granted_at"] is not None


@pytest.mark.parametrize(("path", "body"), AI_CALLS)
async def test_withdrawal_sets_revoked_at_and_a_new_consent_clears_it_in_the_same_row(
    ai: AiBackend, client: httpx.AsyncClient, path: str, body: dict[str, Any]
) -> None:
    assert (await put(client)).status_code == 200
    withdrawn = await client.delete("/v1/ai/consent", headers=auth())
    assert withdrawn.status_code == 200
    assert withdrawn.json()["granted"] is False
    row = await ai.consent_row("anthropic")
    assert row is not None
    assert row.revoked_at is not None
    assert_consent_required(await client.post(path, json=body, headers=auth()))
    assert ai.provider.calls == []

    again = await put(client, personal=True)
    assert again.status_code == 200
    assert again.json()["granted"] is True
    row = await ai.consent_row("anthropic")
    assert row is not None
    assert row.revoked_at is None
    assert row.personal_text is True
    if ai.pool is not None:
        assert await ai.pool.fetchval("SELECT count(*) FROM yawmi.ai_consents") == 1
    else:
        assert len(ai.consents.rows) == 1
    assert (await client.post(path, json=body, headers=auth())).status_code == 200
    assert len(ai.provider.calls) == 1


async def test_withdrawing_without_a_consent_is_harmless(client: httpx.AsyncClient) -> None:
    resp = await client.delete("/v1/ai/consent", headers=auth())
    assert resp.status_code == 200
    assert resp.json()["granted"] is False


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
async def test_the_consent_routes_need_a_device_token(
    client: httpx.AsyncClient, method: str
) -> None:
    body = {"provider": "anthropic", "personal_text": False} if method == "PUT" else None
    assert (await client.request(method, "/v1/ai/consent", json=body)).status_code == 401
    service = await client.request(method, "/v1/ai/consent", json=body, headers=auth("service"))
    assert service.status_code == 403


async def test_reviews_need_no_consent(client: httpx.AsyncClient) -> None:
    resp = await client.get("/v1/reviews", headers=auth())
    assert resp.status_code == 200


def test_consent_messages_are_gender_neutral() -> None:
    from test_insights_routes import _gendered_hit, _gendered_words

    words = _gendered_words()
    for message in (MSG_CONSENT_REQUIRED, MSG_PROVIDER_MISMATCH):
        assert _gendered_hit(message, words) is None, message
