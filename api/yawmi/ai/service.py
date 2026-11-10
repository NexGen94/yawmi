"""Grounded insight generation: one request in, one validated `InsightResponse` out.

Guarantees, in order of enforcement:
1. Health policy: `raw_samples` is stripped from the payload unless `send_raw_health` is on, and
   is never allowed to reach DeepSeek (`PolicyViolation` before any call).
2. The reply must match `InsightResponse` (strict keys, at most two lines).
3. Every cited `source_id` (in `source_ids` and in `priorities`) must be one of the request's
   sources: a fabricated id is rejected.
A rejected reply gets exactly one repair attempt (the same request plus a corrective note); a
second rejection raises `InsightInvalid`. Refusals and transport errors are not retried.

Logging: only `request_hash` (SHA-256 of the canonical payload), the kind, the model and reason
codes are written. Request bodies, replies and cited ids never reach a log line.
"""

import hashlib
import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from yawmi.ai.anthropic import AnthropicProvider
from yawmi.ai.base import (
    PolicyViolation,
    Provider,
    ProviderEmpty,
    ProviderError,
    ProviderMalformed,
    ProviderNotConfigured,
)
from yawmi.ai.deepseek import RAW_HEALTH_KEY, DeepSeekProvider
from yawmi.ai.schema import InsightRequest, InsightResponse, insight_json_schema
from yawmi.settings import Settings

logger = logging.getLogger("yawmi.ai")

SYSTEM_PROMPT_PATH = Path(__file__).parent / "prompts" / "ar_system.md"

_CORRECTIONS = {
    "schema": "الرد السابق لا يطابق المخطط: كائن JSON واحد بالمفاتيح المطلوبة الأربعة فقط.",
    "too_many_lines": "الرد السابق تجاوز سطرين في lines؛ الحد الأقصى سطران.",
    "unknown_source": "الرد السابق ذكر معرّف مصدر غير موجود في المدخل.",
    "empty": "الرد السابق كان فارغاً أو ليس كائن JSON.",
}


class InsightInvalid(Exception):
    """The provider's reply was still rejected after the single repair attempt."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("insight rejected: " + ", ".join(reasons))
        self.reasons = reasons


def canonical_json(value: Any) -> str:
    """Stable JSON: sorted keys, no spaces, Arabic kept as-is."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def request_hash(payload: Any) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def has_raw_samples(value: Any) -> bool:
    if isinstance(value, dict):
        return RAW_HEALTH_KEY in value or any(has_raw_samples(v) for v in value.values())
    if isinstance(value, list):
        return any(has_raw_samples(v) for v in value)
    return False


def strip_raw_samples(value: Any) -> Any:
    """A copy of `value` without any `raw_samples` key at any depth."""
    if isinstance(value, dict):
        return {k: strip_raw_samples(v) for k, v in value.items() if k != RAW_HEALTH_KEY}
    if isinstance(value, list):
        return [strip_raw_samples(v) for v in value]
    return value


@lru_cache(maxsize=1)
def load_system_prompt() -> str:
    return SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")


def build_provider(settings: Settings) -> Provider:
    """The adapter `settings.ai_provider` selects; a missing key is `ProviderNotConfigured`."""
    if settings.ai_provider == "deepseek":
        if settings.deepseek_api_key is None:
            raise ProviderNotConfigured("deepseek_api_key is not set")
        return DeepSeekProvider(settings.deepseek_api_key)
    if settings.anthropic_api_key is None:
        raise ProviderNotConfigured("anthropic_api_key is not set")
    return AnthropicProvider(settings.anthropic_api_key)


def _is_too_many_lines(error: Any) -> bool:
    return error["type"] == "too_long" and error["loc"][:1] == ("lines",)


class InsightService:
    def __init__(self, provider: Provider, settings: Settings) -> None:
        self._provider = provider
        self._settings = settings

    def _is_deepseek(self) -> bool:
        return (
            getattr(self._provider, "name", None) == "deepseek"
            or self._settings.ai_provider == "deepseek"
        )

    def _payload(self, req: InsightRequest) -> dict[str, Any]:
        """What the model sees, after the health-data policy has been applied."""
        payload = req.model_dump(mode="json")
        if has_raw_samples(payload):
            if not self._settings.send_raw_health:
                return strip_raw_samples(payload)
            if self._is_deepseek():
                raise PolicyViolation("raw health samples must never be sent to DeepSeek")
        return payload

    def _model_for(self, req: InsightRequest) -> str:
        return self._settings.model_weekly if req.kind == "weekly" else self._settings.model_daily

    @staticmethod
    def _check(raw: dict, allowed_ids: set[str]) -> tuple[InsightResponse | None, list[str]]:
        """Validate a reply; the second item lists reason codes (never any reply content)."""
        try:
            response = InsightResponse.model_validate(raw)
        except ValidationError as exc:
            errors = exc.errors()
            reasons = []
            if any(_is_too_many_lines(e) for e in errors):
                reasons.append("too_many_lines")
            if any(not _is_too_many_lines(e) for e in errors):
                reasons.append("schema")
            return None, reasons
        cited = set(response.source_ids) | {p.source_id for p in response.priorities}
        if not cited <= allowed_ids:
            return None, ["unknown_source"]
        return response, []

    @staticmethod
    def _corrective_note(reasons: list[str], allowed_ids: set[str]) -> str:
        parts = [_CORRECTIONS[r] for r in reasons]
        if "unknown_source" in reasons:
            if allowed_ids:
                ids = json.dumps(sorted(allowed_ids), ensure_ascii=False)
                parts.append(f"المعرّفات المسموحة فقط: {ids}.")
            else:
                parts.append("لا مصادر في المدخل: source_ids وpriorities فارغتان.")
        return "[تصحيح] " + " ".join(parts) + " المطلوب: كائن JSON واحد صالح يطابق المخطط."

    async def generate(self, req: InsightRequest) -> InsightResponse:
        payload = self._payload(req)
        digest = request_hash(payload)
        model = self._model_for(req)
        allowed_ids = {s["id"] for s in payload["sources"]}
        system = load_system_prompt()
        schema = insight_json_schema()
        user = canonical_json(payload)

        reasons: list[str] = []
        for attempt in (1, 2):
            message = user
            if attempt == 2:
                message = f"{user}\n\n{self._corrective_note(reasons, allowed_ids)}"
            try:
                raw = await self._provider.complete(system, message, schema, model)
            except (ProviderEmpty, ProviderMalformed):
                reasons = ["empty"]
                continue
            except ProviderError as exc:
                logger.warning(
                    "insight provider_failure kind=%s model=%s error=%s request_hash=%s",
                    req.kind,
                    model,
                    type(exc).__name__,
                    digest,
                )
                raise
            response, reasons = self._check(raw, allowed_ids)
            if response is not None:
                logger.info(
                    "insight ok kind=%s model=%s attempts=%d request_hash=%s",
                    req.kind,
                    model,
                    attempt,
                    digest,
                )
                return response

        logger.warning(
            "insight invalid kind=%s model=%s reasons=%s request_hash=%s",
            req.kind,
            model,
            ",".join(reasons),
            digest,
        )
        raise InsightInvalid(reasons)
