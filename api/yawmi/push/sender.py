"""Send one Web Push message with pywebpush's async path (aiohttp) and classify the answer.

The message is a declarative push payload (`{"web_push": 8030, "notification": {...}}`): Safari
16.4+ on iOS shows it without running the service worker, and the worker's `push` handler shows
the same notification on browsers that do not know the format.

Headers: `TTL: 3600` (a reminder older than an hour is useless) and `Urgency: high`; VAPID claims
`{"sub": <mailto subject>}` (pywebpush adds `aud` and `exp`). The answer decides what happens to
the subscription, and there is never an immediate retry:

* 2xx: `sent`.
* 404/410: `gone`, the caller deletes the subscription.
* 429/503: `retry`, with `retry_after` taken from the `Retry-After` header (seconds or an HTTP
  date; one minute when absent, one day at most); the caller skips the subscription until then.
* anything else, and network errors: `failed`; the subscription is kept as is.

The private key, the endpoint's path and the payload are never logged here.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any, Literal

import aiohttp
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush_async

from yawmi.push.store import Subscription

TTL_SECONDS = 3600
URGENCY = "high"
# A push service accepts at most 4096 bytes of encrypted body. aes128gcm adds an 86-byte header
# (salt 16, record size 4, key id length 1, key id 65), a 1-byte padding delimiter and a 16-byte
# tag, so the JSON itself may take what is left.
MAX_RECORD_BYTES = 4096
AES128GCM_OVERHEAD = 86 + 1 + 16
MAX_PAYLOAD_BYTES = MAX_RECORD_BYTES - AES128GCM_OVERHEAD
DEFAULT_RETRY = timedelta(minutes=1)
MAX_RETRY = timedelta(days=1)
TIMEOUT = aiohttp.ClientTimeout(total=10)

Outcome = Literal["sent", "gone", "retry", "failed"]


class PayloadTooLarge(ValueError):
    """The encoded payload would not fit in one push message."""


@dataclass(frozen=True)
class SendResult:
    outcome: Outcome
    status: int | None = None
    retry_after: datetime | None = None


def encode_payload(payload: dict[str, Any]) -> bytes:
    """Compact UTF-8 JSON; `PayloadTooLarge` above `MAX_PAYLOAD_BYTES` (only the size is named)."""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise PayloadTooLarge(f"push payload is {len(raw)} bytes; the limit is {MAX_PAYLOAD_BYTES}")
    return raw


def retry_at(header: str | None, now: datetime) -> datetime:
    """When to try again, from a `Retry-After` value (delta seconds or HTTP date), clamped."""
    delay = DEFAULT_RETRY
    value = (header or "").strip()
    if value.isdigit():
        delay = timedelta(seconds=int(value[:9]))  # nine digits are already past the cap
    elif value:
        try:
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            when = None
        if when is not None and when.tzinfo is not None:
            delay = when - now
    return now + min(max(delay, timedelta(0)), MAX_RETRY)


def classify(status: int | None, retry_after: str | None, now: datetime) -> SendResult:
    if status is not None and 200 <= status < 300:
        return SendResult("sent", status)
    if status in (404, 410):
        return SendResult("gone", status)
    if status in (429, 503):
        return SendResult("retry", status, retry_at(retry_after, now))
    return SendResult("failed", status)


class WebPushSender:
    """Signs with the VAPID key and posts through one reusable aiohttp session."""

    def __init__(self, private_key: ec.EllipticCurvePrivateKey, subject: str) -> None:
        self._vapid = Vapid02(private_key=private_key)
        self._subject = subject
        self._session: aiohttp.ClientSession | None = None

    def _client(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=TIMEOUT)
        return self._session

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def send(
        self, sub: Subscription, payload: dict[str, Any], *, now: datetime | None = None
    ) -> SendResult:
        """Send `payload` to `sub` once. Raises `PayloadTooLarge` before any request."""
        data = encode_payload(payload)
        now = now or datetime.now(UTC)
        try:
            response = await webpush_async(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=data.decode("utf-8"),
                vapid_private_key=self._vapid,
                # a fresh dict every time: pywebpush writes `aud` and `exp` into it
                vapid_claims={"sub": self._subject},
                ttl=TTL_SECONDS,
                headers={"Urgency": URGENCY},
                timeout=TIMEOUT,  # type: ignore[arg-type]  # passed through to aiohttp
                aiohttp_session=self._client(),
            )
        except WebPushException as exc:
            return classify(exc.status_code, exc.retry_after, now)
        except (aiohttp.ClientError, TimeoutError):
            return SendResult("failed")
        return classify(getattr(response, "status", None), None, now)
