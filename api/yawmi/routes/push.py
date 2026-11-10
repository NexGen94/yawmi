"""`/v1/push`: the VAPID public key and the device's Web Push subscription.

* `GET /v1/push/vapid-public-key` -> `{key}`, the `applicationServerKey` for `pushManager.subscribe`
  (503 while push is off or its key is not in place).
* `POST /v1/push/subscribe` `{endpoint, keys: {p256dh, auth}}` -> 204: upsert, owned by the
  calling device.
* `DELETE /v1/push/subscribe` `{endpoint}` -> 204: removes it if the calling device owns it
  (idempotent: an unknown or foreign endpoint is a 204 that changes nothing).

Any paired device may subscribe except a service token, and not once it is revoked (403). A
device holds at most `MAX_PER_DEVICE` subscriptions (409 beyond). Endpoints pass the shared
check in `yawmi.push.hosts`: `https`, no credentials, no IP literal, port 443, and a host on the
settings' allow-list of push services (422 `endpoint_not_allowed` otherwise); the sender checks
again before every send. Every field is bounded, and `p256dh` must be a point on P-256. This
module imports neither pywebpush nor aiohttp: sending lives in `yawmi.push.sender`, loaded only
when push is enabled.
"""

import base64
import binascii
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from pydantic_core import PydanticCustomError

from yawmi.auth.deps import CurrentDevice, SettingsDep, forbidden, require_kind
from yawmi.auth.tokens import AccessClaims
from yawmi.db.pool import get_pool
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.push.hosts import endpoint_problem
from yawmi.push.store import MAX_PER_DEVICE, AsyncpgPushStore, PushStore
from yawmi.push.vapid import VapidKeyError, load_private_key, public_key_b64url
from yawmi.text import StorableText

router = APIRouter(prefix="/v1/push", tags=["push"])

SUBSCRIBER_KINDS = ("iphone", "watch", "web")  # every kind but `service`
MAX_ENDPOINT = 2048
PUSH_OFF = "الإشعارات غير مفعّلة"

_NOT_HTTPS = "عنوان الاشتراك يجب أن يكون https بمضيف وبلا بيانات دخول ولا عنوان IP ولا منفذ آخر"
_NOT_ALLOWED = "عنوان الاشتراك ليس من خدمات الدفع المسموح بها"
TOO_MANY = "بلغ هذا الجهاز الحد الأقصى من الاشتراكات"
_BAD_P256DH = "مفتاح p256dh ليس نقطة P-256 غير مضغوطة"
_BAD_AUTH = "سر auth ليس 16 بايتاً"

B64Url = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]+={0,2}$")]


def _b64url_bytes(text: str) -> bytes | None:
    try:
        return base64.urlsafe_b64decode(text.rstrip("=") + "=" * (-len(text.rstrip("=")) % 4))
    except (binascii.Error, ValueError):
        return None


class SubscriptionKeys(BaseModel):
    model_config = ConfigDict(extra="forbid")

    p256dh: Annotated[B64Url, Field(max_length=100, description="نقطة P-256 غير مضغوطة، base64url")]
    auth: Annotated[B64Url, Field(max_length=32, description="سر المصادقة 16 بايتاً، base64url")]

    @field_validator("p256dh")
    @classmethod
    def _point(cls, value: str) -> str:
        raw = _b64url_bytes(value)
        if raw is None or len(raw) != 65 or raw[0] != 4:
            raise PydanticCustomError("p256dh_invalid", _BAD_P256DH)
        try:
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
        except ValueError:  # 65 bytes, but not a point on the curve
            raise PydanticCustomError("p256dh_invalid", _BAD_P256DH) from None
        return value

    @field_validator("auth")
    @classmethod
    def _secret(cls, value: str) -> str:
        raw = _b64url_bytes(value)
        if raw is None or len(raw) != 16:
            raise PydanticCustomError("auth_invalid", _BAD_AUTH)
        return value


Endpoint = Annotated[
    StorableText,
    Field(min_length=1, max_length=MAX_ENDPOINT, description="عنوان https من خدمة الدفع"),
]


def _check_endpoint(value: str) -> str:
    """The shape half of the shared check; the allow-list half needs the settings (route)."""
    if endpoint_problem(value, None) is not None:
        raise PydanticCustomError("endpoint_not_https", _NOT_HTTPS)
    return value


def _require_allowed_host(endpoint: str, allowed: list[str]) -> None:
    """422 in the app's usual shape when the endpoint's host is not an allowed push service."""
    if endpoint_problem(endpoint, allowed) is not None:
        raise RequestValidationError(
            [
                {
                    "loc": ("body", "endpoint"),
                    "type": "endpoint_not_allowed",
                    "msg": _NOT_ALLOWED,
                    "input": None,
                }
            ]
        )


class SubscribeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: Endpoint
    keys: SubscriptionKeys

    @field_validator("endpoint")
    @classmethod
    def _https(cls, value: str) -> str:
        return _check_endpoint(value)


class UnsubscribeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: Endpoint


class VapidKeyOut(BaseModel):
    key: str = Field(description="المفتاح العام لـVAPID: نقطة P-256 غير مضغوطة، base64url")


def get_push_store(request: Request) -> PushStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: PushStore | None = getattr(request.app.state, "push_store", None)
    return injected if injected is not None else AsyncpgPushStore(get_pool())


PushStoreDep = Annotated[PushStore, Depends(get_push_store)]
Subscriber = Annotated[AccessClaims, Depends(require_kind(*SUBSCRIBER_KINDS))]

UNAVAILABLE = {503: {"model": ErrorDetail, "description": PUSH_OFF}}
CONFLICT = {409: {"model": ErrorDetail, "description": TOO_MANY}}


@lru_cache(maxsize=4)
def _public_key(path: Path, mtime_ns: int) -> str:
    return public_key_b64url(load_private_key(path))


@router.get(
    "/vapid-public-key",
    summary="مفتاح VAPID العام للاشتراك في الإشعارات",
    responses={**UNAUTHORIZED, **UNAVAILABLE},
)
async def vapid_public_key(_: CurrentDevice, settings: SettingsDep) -> VapidKeyOut:
    path = settings.vapid_private_key_file
    if not settings.push_enabled or path is None:
        raise HTTPException(status_code=503, detail=PUSH_OFF)
    try:
        return VapidKeyOut(key=_public_key(path, path.stat().st_mtime_ns))
    except (OSError, VapidKeyError):
        raise HTTPException(status_code=503, detail=PUSH_OFF) from None


@router.post(
    "/subscribe",
    status_code=204,
    summary="تسجيل اشتراك الإشعارات لهذا الجهاز",
    description=(
        "يحفظ اشتراك Web Push مربوطاً بالجهاز المصادَق، ويستبدل مفاتيح العنوان نفسه إن وُجد ويلغي "
        "أي تأجيل عليه. العنوان https على خدمة دفع مسموح بها فقط. رمز الخدمة والجهاز الملغى لا "
        f"يشتركان، وللجهاز {MAX_PER_DEVICE} اشتراكات على الأكثر."
    ),
    responses={**UNAUTHORIZED, **FORBIDDEN, **CONFLICT, **INVALID},
)
async def subscribe(
    body: SubscribeIn, claims: Subscriber, store: PushStoreDep, settings: SettingsDep
) -> Response:
    _require_allowed_host(body.endpoint, settings.push_hosts)
    result = await store.upsert_subscription(
        claims.sub, body.endpoint, body.keys.p256dh, body.keys.auth
    )
    if result == "revoked":
        raise forbidden()
    if result == "limit":
        raise HTTPException(status_code=409, detail=TOO_MANY)
    return Response(status_code=204)


@router.delete(
    "/subscribe",
    status_code=204,
    summary="إلغاء اشتراك الإشعارات لهذا الجهاز",
    description="يحذف الاشتراك إن كان لهذا الجهاز، وإلا لا يغيّر شيئاً (204 في الحالتين).",
    responses={**UNAUTHORIZED, **FORBIDDEN, **INVALID},
)
async def unsubscribe(body: UnsubscribeIn, claims: Subscriber, store: PushStoreDep) -> Response:
    await store.delete_subscription(claims.sub, body.endpoint)
    return Response(status_code=204)
