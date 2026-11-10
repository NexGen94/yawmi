"""Provider contract and the errors every adapter and the service share."""

import json
from typing import Any, Protocol

import httpx
from pydantic import SecretStr

TIMEOUT_SECONDS = 30.0


class ProviderError(Exception):
    """The provider call failed (transport, HTTP status, truncation). Not retried by adapters."""


class ProviderRefusal(ProviderError):
    """The model declined to answer (Anthropic `stop_reason == "refusal"`)."""


class ProviderEmpty(ProviderError):
    """The call succeeded but carried no content (DeepSeek `json_object` may return nothing)."""


class ProviderMalformed(ProviderError):
    """The reply was not a JSON object."""


class ProviderNotConfigured(ProviderError):
    """The selected provider has no API key in the environment."""


class PolicyViolation(Exception):
    """A request would break the data policy (raw health samples must never reach DeepSeek)."""


class Provider(Protocol):
    """One LLM backend. `complete` returns the parsed JSON object the model produced."""

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict: ...


def reveal_key(key: str | SecretStr) -> str:
    return key.get_secret_value() if isinstance(key, SecretStr) else key


async def post_json(
    client: httpx.AsyncClient | None, url: str, headers: dict[str, str], body: dict[str, Any]
) -> httpx.Response:
    """POST once with the shared 30 s timeout. Failures surface as `ProviderError` (type only).

    No retries happen here: the service decides whether a second attempt is worth making.
    Neither the key, the request body nor the response body ever enters an exception message.
    """
    try:
        if client is not None:
            return await client.post(url, json=body, headers=headers, timeout=TIMEOUT_SECONDS)
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as fresh:
            return await fresh.post(url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise ProviderError(f"request failed: {type(exc).__name__}") from exc


def parse_json_object(text: str | None) -> dict:
    """Parse the model's text as one JSON object; blank text is `ProviderEmpty`."""
    if text is None or not text.strip():
        raise ProviderEmpty("the reply carried no content")
    try:
        value = json.loads(text)
    except ValueError as exc:
        raise ProviderMalformed("the reply is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ProviderMalformed("the reply is not a JSON object")
    return value
