"""Pairing, refresh-token rotation and revocation.

Pairing fails closed: `PairingGuard` counts failed pairings in memory, per process; when more
than `MAX_PAIRING_FAILURES` fail within `PAIRING_FAILURE_WINDOW`, every unused code is expired and
the owner issues a new one with `yawmi-admin pair-code`. A success neither counts nor resets the
count. This backs up the Traefik rate limit, which guards the public host only.

Native devices (`iphone`, `watch`) keep the refresh token themselves. A `web` device never sees
it: it lives in the `yawmi_rt` cookie (HttpOnly, Strict, scoped to `/v1/auth`) and the response
body carries `refresh_token: null`.
"""

import logging
import time
from collections import deque
from collections.abc import Callable
from datetime import timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel, StringConstraints

from yawmi.auth.deps import (
    DevicesDep,
    DeviceStore,
    SettingsDep,
    forbidden,
    require_kind,
    unauthorized,
)
from yawmi.auth.tokens import hash_refresh, issue_access, new_refresh
from yawmi.errors import INVALID, ErrorDetail
from yawmi.settings import Settings
from yawmi.text import StorableText

COOKIE_NAME = "yawmi_rt"
COOKIE_PATH = "/v1/auth"
BAD_PAIRING_CODE = "الكود غير صالح أو منتهٍ"
DEVICE_NOT_FOUND = "الجهاز غير موجود"

MAX_PAIRING_FAILURES = 20
PAIRING_FAILURE_WINDOW = 600.0  # seconds

log = logging.getLogger("yawmi.auth")

router = APIRouter(prefix="/v1", tags=["devices"])


class PairingGuard:
    """Failed pairings of the last `window` seconds, in memory (one process, one count)."""

    def __init__(
        self,
        *,
        limit: int = MAX_PAIRING_FAILURES,
        window: float = PAIRING_FAILURE_WINDOW,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window = window
        self.clock = clock
        self._failures: deque[float] = deque()

    def record_failure(self) -> bool:
        """Count one failure; `True` when the failures in the window now exceed the limit."""
        now = self.clock()
        self._failures.append(now)
        while self._failures and self._failures[0] <= now - self.window:
            self._failures.popleft()
        return len(self._failures) > self.limit


def get_pairing_guard(request: Request) -> PairingGuard:
    guard: PairingGuard | None = getattr(request.app.state, "pairing_guard", None)
    if guard is None:
        guard = request.app.state.pairing_guard = PairingGuard()
    return guard


PairingGuardDep = Annotated[PairingGuard, Depends(get_pairing_guard)]


async def _pairing_failed(devices: DeviceStore, guard: PairingGuard) -> HTTPException:
    if guard.record_failure():
        expired = await devices.expire_pairing_codes()
        # counts only: never a code or a client address
        log.warning("pairing failed too often: %d unused code(s) expired", expired)
    return HTTPException(status_code=400, detail=BAD_PAIRING_CODE)


class PairRequest(BaseModel):
    # NUL and lone surrogates are a 422 here: Postgres cannot store them (it would be a 500)
    code: Annotated[StorableText, StringConstraints(min_length=1, max_length=32)]
    name: Annotated[
        StorableText, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)
    ]
    # `service` is accepted by the schema only so that it can be refused with 403, not 422.
    kind: Literal["iphone", "watch", "web", "service"]


class RefreshRequest(BaseModel):
    """Native clients send both fields; web clients send no body and rely on the cookie."""

    device_id: UUID | None = None
    refresh_token: str | None = None


class TokenPair(BaseModel):
    device_id: UUID
    access_token: str
    refresh_token: str | None  # `null` for `web`: the token is in the cookie


def refresh_cookie(device_id: UUID, raw: str, *, secure: bool, max_age: int) -> str:
    """`Set-Cookie` value for the web refresh token (`<device_id>.<raw>`)."""
    parts = [f"{COOKIE_NAME}={device_id}.{raw}", "HttpOnly"]
    if secure:
        parts.append("Secure")
    parts += ["SameSite=Strict", f"Path={COOKIE_PATH}", f"Max-Age={max_age}"]
    return "; ".join(parts)


def _token_pair(
    response: Response, settings: Settings, device_id: UUID, kind: str, raw_refresh: str
) -> TokenPair:
    access = issue_access(
        device_id, kind, settings.jwt_secret.get_secret_value(), settings.jwt_ttl_seconds
    )
    response.headers["Cache-Control"] = "no-store"
    if kind == "web":
        cookie = refresh_cookie(
            device_id,
            raw_refresh,
            secure=settings.cookie_secure,
            max_age=settings.refresh_ttl_days * 86400,
        )
        response.headers.append("set-cookie", cookie)
        return TokenPair(device_id=device_id, access_token=access, refresh_token=None)
    return TokenPair(device_id=device_id, access_token=access, refresh_token=raw_refresh)


def _credentials(body: RefreshRequest | None, cookie: str | None) -> tuple[UUID, str]:
    """Pick the refresh credentials: the body when complete, else the `yawmi_rt` cookie."""
    if body is not None and body.device_id is not None and body.refresh_token:
        return body.device_id, body.refresh_token
    if cookie:
        raw_id, _, raw = cookie.partition(".")
        try:
            device_id = UUID(raw_id)
        except ValueError:
            raise unauthorized(bearer=False) from None
        if raw:
            return device_id, raw
    raise unauthorized(bearer=False)


@router.post(
    "/devices/pair",
    summary="إقران جهاز جديد بكود لمرة واحدة",
    responses={
        400: {"model": ErrorDetail, "description": BAD_PAIRING_CODE},
        403: {"model": ErrorDetail, "description": "نوع الجهاز لا يُقرن"},
        **INVALID,
    },
)
async def pair_device(
    body: PairRequest,
    response: Response,
    devices: DevicesDep,
    settings: SettingsDep,
    guard: PairingGuardDep,
) -> TokenPair:
    if body.kind == "service":
        raise forbidden()
    pairing = await devices.consume_pairing_code(body.code)
    # A code is bound to the kind it was issued for. A mismatch still burns it (one-time code).
    if pairing is None or pairing.kind != body.kind:
        raise await _pairing_failed(devices, guard)
    raw, digest = new_refresh()
    device_id = await devices.create_device(body.name, body.kind, digest)
    return _token_pair(response, settings, device_id, body.kind, raw)


@router.post(
    "/auth/refresh",
    summary="تدوير رمز التجديد وإصدار رمز وصول جديد",
    responses={
        401: {"model": ErrorDetail, "description": "رمز التجديد غير صالح أو الجهاز مُبطَل"},
        **INVALID,
    },
)
async def refresh_tokens(
    response: Response,
    devices: DevicesDep,
    settings: SettingsDep,
    body: RefreshRequest | None = None,
    yawmi_rt: Annotated[str | None, Cookie()] = None,
) -> TokenPair:
    device_id, raw = _credentials(body, yawmi_rt)
    device = await devices.get_device(device_id)
    if device is None or device.revoked_at is not None:
        raise unauthorized(bearer=False)
    new_raw, new_digest = new_refresh()
    # Atomic compare-and-swap: a replayed (already rotated) token matches nothing, and a token
    # older than `refresh_ttl_days` is dead on the server even if a client kept it (I-3).
    max_age = timedelta(days=settings.refresh_ttl_days)
    if not await devices.rotate_refresh(device_id, hash_refresh(raw), new_digest, max_age=max_age):
        raise unauthorized(bearer=False)
    return _token_pair(response, settings, device_id, device.kind, new_raw)


@router.post(
    "/devices/{device_id}/revoke",
    status_code=204,
    summary="إبطال جهاز (لرمز الخدمة فقط)",
    dependencies=[Depends(require_kind("service"))],
    responses={
        403: {"model": ErrorDetail, "description": "غير مسموح"},
        404: {"model": ErrorDetail, "description": DEVICE_NOT_FOUND},
        **INVALID,
    },
)
async def revoke_device(device_id: UUID, devices: DevicesDep) -> None:
    if not await devices.revoke(device_id):
        raise HTTPException(status_code=404, detail=DEVICE_NOT_FOUND)
