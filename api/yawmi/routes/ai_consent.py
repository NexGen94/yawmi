"""`GET`, `PUT` and `DELETE /v1/ai/consent`: consent to send data to the configured AI provider.

The consent is read and written for `settings.ai_provider` only: a `PUT` naming another provider
is a 409 `provider_mismatch`. `DELETE` withdraws it (sets `revoked_at`, the row stays) and a later
`PUT` renews the same row. Each answers the current state as `ConsentOut`.
This module is discovered automatically (see `yawmi.routes`).
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from yawmi.ai.consent import (
    MSG_PROVIDER_MISMATCH,
    PROVIDER_MISMATCH,
    ConsentIn,
    ConsentOut,
    ConsentStoreDep,
    consent_out,
    now_utc,
    problem,
)
from yawmi.auth.deps import USER_KINDS, SettingsDep, require_kind
from yawmi.auth.tokens import AccessClaims
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ValidationErrorBody

router = APIRouter(
    prefix="/v1",
    tags=["ai"],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)

DeviceDep = Annotated[AccessClaims, Depends(require_kind(*USER_KINDS))]


@router.get(
    "/ai/consent",
    summary="الموافقة على إرسال البيانات إلى مزوّد الذكاء الحالي",
    response_model=ConsentOut,
)
async def get_consent(_: DeviceDep, store: ConsentStoreDep, settings: SettingsDep) -> ConsentOut:
    return consent_out(settings.ai_provider, await store.get(settings.ai_provider))


@router.put(
    "/ai/consent",
    summary="منح الموافقة أو تجديدها",
    description=(
        "يُرسل أرقام العادات والأهداف وكلمات اليومية إلى المزوّد الحالي بعد الموافقة. و"
        "`personal_text` يضيف «رسالتي» و«رؤيتي». مزوّد غير الحالي 409 `provider_mismatch`. "
        "الموافقة بعد السحب تجدّد الصف نفسه."
    ),
    response_model=ConsentOut,
    responses={
        409: {"model": ValidationErrorBody, "description": MSG_PROVIDER_MISMATCH},
        **INVALID,
    },
)
async def put_consent(
    body: ConsentIn, device: DeviceDep, store: ConsentStoreDep, settings: SettingsDep
) -> ConsentOut | JSONResponse:
    if body.provider != settings.ai_provider:
        return problem(409, MSG_PROVIDER_MISMATCH, PROVIDER_MISMATCH, ["body", "provider"])
    consent = await store.grant(body.provider, body.personal_text, device.sub, now_utc())
    return consent_out(settings.ai_provider, consent)


@router.delete(
    "/ai/consent",
    summary="سحب الموافقة",
    description="يملأ `revoked_at` ولا يحذف الصف، فتعيد مسارات الذكاء 403 بعده. تكراره بلا أثر.",
    response_model=ConsentOut,
)
async def delete_consent(_: DeviceDep, store: ConsentStoreDep, settings: SettingsDep) -> ConsentOut:
    return consent_out(settings.ai_provider, await store.revoke(settings.ai_provider, now_utc()))
