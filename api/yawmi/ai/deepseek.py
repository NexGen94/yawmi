"""DeepSeek adapter: OpenAI-compatible chat completions in `json_object` mode.

`json_object` does not enforce a schema and may return an empty reply, so the schema is spelled
out in the system prompt and the service validates the result. This adapter never carries raw
health samples: a payload that contains `raw_samples` is refused before any HTTP call, whatever
the settings say.
"""

import json
from typing import Any

import httpx
from pydantic import SecretStr

from yawmi.ai.base import (
    PolicyViolation,
    ProviderError,
    ProviderRefusal,
    parse_json_object,
    post_json,
    reveal_key,
)

API_URL = "https://api.deepseek.com/chat/completions"
RAW_HEALTH_KEY = "raw_samples"

_SCHEMA_INTRO = "\n\nيجب أن يكون الرد كائن JSON واحداً فقط يطابق مخطط JSON التالي حرفياً:\n"


class DeepSeekProvider:
    name = "deepseek"

    def __init__(
        self,
        api_key: str | SecretStr,
        *,
        max_tokens: int = 1024,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = SecretStr(reveal_key(api_key))
        self._max_tokens = max_tokens
        self._client = client

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        # Fail closed before any network use: substring match also catches the key inside text.
        if RAW_HEALTH_KEY in user:
            raise PolicyViolation("raw health samples must never be sent to DeepSeek")

        response = await post_json(
            self._client,
            API_URL,
            {
                "Authorization": f"Bearer {self._api_key.get_secret_value()}",
                "content-type": "application/json",
            },
            {
                "model": model,
                "max_tokens": self._max_tokens,
                "messages": [
                    {
                        "role": "system",
                        "content": system + _SCHEMA_INTRO + json.dumps(schema, ensure_ascii=False),
                    },
                    {"role": "user", "content": user},
                ],
                "response_format": {"type": "json_object"},
            },
        )
        if response.status_code != 200:
            raise ProviderError(f"DeepSeek returned HTTP {response.status_code}")
        try:
            data: Any = response.json()
            choice = data["choices"][0]
            finish_reason = choice.get("finish_reason")
            content = (choice.get("message") or {}).get("content")
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            raise ProviderError("DeepSeek returned an unexpected body") from exc

        if finish_reason == "content_filter":
            raise ProviderRefusal("the reply was blocked by the provider's content filter")
        if finish_reason == "length":
            raise ProviderError("the reply was cut off at the length limit")
        return parse_json_object(content)
