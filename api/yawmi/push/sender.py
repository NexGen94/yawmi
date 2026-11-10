"""Send one Web Push message and classify the answer.

The message is a declarative push payload (`{"web_push": 8030, "notification": {...}}`): Safari
18.4+ shows it without running the service worker, and the worker's `push` handler shows the
same notification on browsers that do not know the format.

pywebpush encrypts (`WebPusher.encode`, aes128gcm) and py_vapid signs the VAPID JWT
(`{"sub": <mailto subject>, "aud": <endpoint origin>, "exp": now + 12 h}`). The POST itself is
made here with aiohttp rather than by pywebpush, because the endpoint is untrusted input:

* the endpoint is checked again just before the send (`hosts.endpoint_problem`); a failing one is
  `refused` and never contacted (the caller drops the row);
* redirects are never followed; a 3xx is `failed`;
* the response body is never read, only the status and `Retry-After`;
* the connector's resolver refuses any address that is not global (`GlobalOnlyResolver`).

Headers: `TTL: 3600` and `Urgency: high`. The answer decides what happens to the subscription,
and there is never an immediate retry:

* 2xx: `sent`. 404/410: `gone`, the caller deletes the subscription.
* 429/503: `retry`, with `retry_after` from `Retry-After` (seconds or an HTTP date; one minute
  when absent or unreadable, one day at most); the caller skips the subscription until then.
* anything else, and network errors: `failed`; the subscription is kept as is.

The private key, the endpoint's path and the payload are never logged here.
"""

import ipaddress
import json
import socket
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from functools import partial
from typing import Any, Literal
from urllib.parse import urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver, ResolveResult
from aiohttp.resolver import DefaultResolver
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02
from pywebpush import WebPusher

from yawmi.push.hosts import DEFAULT_PUSH_HOSTS, endpoint_problem
from yawmi.push.store import Subscription

TTL_SECONDS = 3600
URGENCY = "high"
JWT_LIFETIME_SECONDS = 12 * 60 * 60
# A push service accepts at most 4096 bytes of encrypted body. aes128gcm adds an 86-byte header
# (salt 16, record size 4, key id length 1, key id 65), a 1-byte padding delimiter and a 16-byte
# tag, so the JSON itself may take what is left.
MAX_RECORD_BYTES = 4096
AES128GCM_OVERHEAD = 86 + 1 + 16
MAX_PAYLOAD_BYTES = MAX_RECORD_BYTES - AES128GCM_OVERHEAD
DEFAULT_RETRY = timedelta(minutes=1)
MAX_RETRY = timedelta(days=1)
TIMEOUT = aiohttp.ClientTimeout(total=10)

Outcome = Literal["sent", "gone", "retry", "failed", "refused"]
EndpointCheck = Callable[[str], str | None]


class PayloadTooLarge(ValueError):
    """The encoded payload would not fit in one push message."""


class NotGlobalAddress(OSError):
    """A push host resolved to a loopback, private, link-local or otherwise non-global address."""


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
    if value.isascii() and value.isdigit():
        delay = timedelta(seconds=int(value[:9]))  # nine digits are already past the cap
    elif value:
        try:
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            when = None
        if when is not None and when.tzinfo is not None:
            delay = when - now
    return now + min(max(delay, timedelta(0)), MAX_RETRY)


def classify(status: int, retry_after: str | None, now: datetime) -> SendResult:
    if 200 <= status < 300:
        return SendResult("sent", status)
    if status in (404, 410):
        return SendResult("gone", status)
    if status in (429, 503):
        return SendResult("retry", status, retry_at(retry_after, now))
    return SendResult("failed", status)  # 3xx included: redirects are never followed


def is_global(address: str) -> bool:
    try:
        return ipaddress.ip_address(address.split("%", 1)[0]).is_global
    except ValueError:
        return False


class GlobalOnlyResolver(AbstractResolver):
    """Resolves like aiohttp's default resolver, but refuses a host if any address is not global.

    So a push host whose DNS points at loopback, a private range, link-local or the Docker
    networks the API sits on is never connected to.
    """

    def __init__(self, inner: AbstractResolver | None = None) -> None:
        self._inner = inner or DefaultResolver()

    async def resolve(
        self, host: str, port: int = 0, family: socket.AddressFamily = socket.AF_INET
    ) -> list[ResolveResult]:
        results = await self._inner.resolve(host, port, family)
        if not results or not all(is_global(r["host"]) for r in results):
            raise NotGlobalAddress("push host resolves to a non-global address")
        return results

    async def close(self) -> None:
        await self._inner.close()


def default_check(allowed: tuple[str, ...] | list[str] = DEFAULT_PUSH_HOSTS) -> EndpointCheck:
    return partial(endpoint_problem, allowed=tuple(allowed))


class WebPushSender:
    """Signs with the VAPID key and posts through one reusable aiohttp session.

    `check` decides which endpoints may be contacted (default: `DEFAULT_PUSH_HOSTS`; production
    passes the settings' list). `global_only=False` drops the resolver guard; only the tests'
    loopback push service uses it, together with an injected `check`.
    """

    def __init__(
        self,
        private_key: ec.EllipticCurvePrivateKey,
        subject: str,
        *,
        check: EndpointCheck | None = None,
        global_only: bool = True,
    ) -> None:
        self._vapid = Vapid02(private_key=private_key)
        self._subject = subject
        self._check = check or default_check()
        self._global_only = global_only
        self._session: aiohttp.ClientSession | None = None

    def _client(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            connector = aiohttp.TCPConnector(
                resolver=GlobalOnlyResolver() if self._global_only else None
            )
            self._session = aiohttp.ClientSession(
                timeout=TIMEOUT, connector=connector, auto_decompress=False
            )
        return self._session

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    def _headers(self, endpoint: str) -> dict[str, str]:
        parts = urlsplit(endpoint)
        claims = {
            "sub": self._subject,
            "aud": f"{parts.scheme}://{parts.netloc}",
            "exp": int(time.time()) + JWT_LIFETIME_SECONDS,
        }
        return {
            **self._vapid.sign(claims),
            "TTL": str(TTL_SECONDS),
            "Urgency": URGENCY,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
        }

    async def send(
        self, sub: Subscription, payload: dict[str, Any], *, now: datetime | None = None
    ) -> SendResult:
        """Send `payload` to `sub` once. Raises `PayloadTooLarge` before any request."""
        data = encode_payload(payload)
        now = now or datetime.now(UTC)
        if self._check(sub.endpoint) is not None:
            return SendResult("refused")
        pusher = WebPusher(
            {"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}
        )
        body = pusher.encode(data, "aes128gcm")["body"]
        try:
            async with self._client().post(
                sub.endpoint,
                data=body,
                headers=self._headers(sub.endpoint),
                allow_redirects=False,
            ) as response:
                # the body is never read: status and Retry-After are all that matter
                return classify(response.status, response.headers.get("Retry-After"), now)
        except (aiohttp.ClientError, TimeoutError, OSError):
            return SendResult("failed")
