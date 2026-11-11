"""Anthropic Messages API adapter (plain `httpx`, no SDK).

Structured output goes through `output_config.format` (`json_schema`). The schema carries no
health values, so it is safe for Anthropic to cache it outside the health-data protections.

Thinking is on by default for both models and its tokens count toward `max_tokens`, so the
budget is 4096 (1024 let a weekly review stop at `max_tokens` before its two lines) and the
effort is `low`: a two-line summary of given facts needs no deep reasoning, and low effort
also cuts cost and latency. `eval/promptfooconfig.yaml` carries the same two values.
"""

from typing import Any

import httpx
from pydantic import SecretStr

from yawmi.ai.base import (
    ProviderError,
    ProviderRefusal,
    parse_json_object,
    post_json,
    reveal_key,
)

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
MAX_TOKENS = 4096
EFFORT = "low"


class AnthropicProvider:
    name = "anthropic"

    def __init__(
        self,
        api_key: str | SecretStr,
        *,
        max_tokens: int = MAX_TOKENS,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = SecretStr(reveal_key(api_key))
        self._max_tokens = max_tokens
        self._client = client

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        response = await post_json(
            self._client,
            API_URL,
            {
                "x-api-key": self._api_key.get_secret_value(),
                "anthropic-version": API_VERSION,
                "content-type": "application/json",
            },
            {
                "model": model,
                "max_tokens": self._max_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user}],
                "output_config": {
                    "format": {"type": "json_schema", "schema": schema},
                    "effort": EFFORT,
                },
            },
        )
        if response.status_code != 200:
            raise ProviderError(f"Anthropic returned HTTP {response.status_code}")
        try:
            data: Any = response.json()
        except ValueError as exc:
            raise ProviderError("Anthropic returned a non-JSON body") from exc

        stop_reason = data.get("stop_reason") if isinstance(data, dict) else None
        if stop_reason == "refusal":
            raise ProviderRefusal("the model refused to answer")
        if stop_reason == "max_tokens":
            raise ProviderError("the reply was cut off at max_tokens")

        blocks = data.get("content") if isinstance(data, dict) else None
        text = next(
            (
                b.get("text")
                for b in blocks or []
                if isinstance(b, dict) and b.get("type") == "text"
            ),
            None,
        )
        return parse_json_object(text)
