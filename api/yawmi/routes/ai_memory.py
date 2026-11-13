"""The visible AI memory (design §7.1, §10): `GET`, `POST`, `DELETE /v1/ai/memory` and
`PATCH`, `DELETE /v1/ai/memory/{memory_id}`.

The list is everything attached to the AI requests, as text: the lenses (`rule`) and the saved
notes (`note`), active or not, and `attached`, whether «رسالتي» and «رؤيتي» go out too (only with
a text and a standing consent that covers personal text). Twenty items at most (422
`memory_full`). `DELETE` on one item removes it for good («حذف بنقرة»); `DELETE` on the collection
empties it. Device tokens only (`service` tokens get 403). Nothing here calls a provider, so no
consent is needed. This module is discovered automatically (see `yawmi.routes`).
"""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError

from yawmi.ai.consent import ConsentStoreDep
from yawmi.ai.memory import (
    MEMORY_FULL,
    MSG_EMPTY_PATCH,
    MSG_ITEM_NOT_FOUND,
    MSG_MEMORY_FULL,
    MemoryAttached,
    MemoryFull,
    MemoryIn,
    MemoryItem,
    MemoryList,
    MemoryPatch,
    MemoryStoreDep,
)
from yawmi.auth.deps import USER_KINDS, SettingsDep, require_kind
from yawmi.db.pool import get_pool
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.prefs.store import AsyncpgPrefsStore, PrefsStore

router = APIRouter(
    prefix="/v1",
    tags=["ai"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


def get_prefs(request: Request) -> PrefsStore:
    """The settings store injected into the app (tests), else Postgres (as in `prefs`)."""
    injected: PrefsStore | None = getattr(request.app.state, "prefs", None)
    return injected if injected is not None else AsyncpgPrefsStore(get_pool())


PrefsDep = Annotated[PrefsStore, Depends(get_prefs)]
NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": MSG_ITEM_NOT_FOUND},
}


@router.get(
    "/ai/memory",
    summary="الذاكرة الظاهرة: كل ما يُرفق بطلبات الذكاء",
    description=(
        "العدسات (`rule`) والملاحظات المحفوظة (`note`) بترتيب إنشائها، المفعّل منها يُرفق بكل "
        "طلب. و`attached` يقول هل تُرفق «رسالتي» و«رؤيتي»: لكل منهما نص وموافقة سارية تشمل "
        "النص الشخصي."
    ),
)
async def list_memory(
    store: MemoryStoreDep,
    consents: ConsentStoreDep,
    prefs_store: PrefsDep,
    settings: SettingsDep,
) -> MemoryList:
    consent = await consents.get(settings.ai_provider)
    personal = consent is not None and consent.standing and consent.personal_text
    prefs = await prefs_store.get()
    attached = MemoryAttached(
        mission=personal and bool(prefs.mission.strip()),
        vision=personal and bool(prefs.vision.strip()),
    )
    return MemoryList(items=await store.list(), attached=attached)


@router.post(
    "/ai/memory",
    status_code=201,
    summary="إضافة عدسة أو ملاحظة",
    description=(
        "بند مفعّل يُرفق بكل طلب. النص من 1 إلى 300 حرف. الحد 20 بنداً، مفعّلة أو معطّلة، "
        "وبعده 422 `memory_full`."
    ),
    responses={**INVALID},
)
async def add_memory(body: MemoryIn, store: MemoryStoreDep) -> MemoryItem:
    try:
        return await store.add(body.kind, body.text)
    except MemoryFull:
        raise RequestValidationError(
            [{"loc": ("body",), "type": MEMORY_FULL, "msg": MSG_MEMORY_FULL}]
        ) from None


@router.delete(
    "/ai/memory",
    status_code=204,
    summary="إعادة ضبط الذاكرة",
    description="يحذف كل البنود. تكراره بلا أثر.",
)
async def reset_memory(store: MemoryStoreDep) -> Response:
    await store.reset()
    return Response(status_code=204)


@router.patch(
    "/ai/memory/{memory_id}",
    summary="تفعيل بند أو تعطيله أو تعديل نصه",
    description="حقل واحد على الأقل. البند المعطّل يبقى في القائمة ولا يُرفق بالطلبات.",
    responses={**NOT_FOUND, **INVALID},
)
async def patch_memory(memory_id: UUID, body: MemoryPatch, store: MemoryStoreDep) -> MemoryItem:
    changes = body.model_dump(include=body.model_fields_set)
    if not changes:
        raise RequestValidationError(
            [{"loc": ("body",), "type": "empty_patch", "msg": MSG_EMPTY_PATCH}]
        )
    item = await store.patch(memory_id, changes)
    if item is None:
        raise HTTPException(status_code=404, detail=MSG_ITEM_NOT_FOUND)
    return item


@router.delete(
    "/ai/memory/{memory_id}",
    status_code=204,
    summary="حذف بند",
    description="حذف فعلي بنقرة. بند غير موجود 404.",
    responses={**NOT_FOUND, **INVALID},
)
async def delete_memory(memory_id: UUID, store: MemoryStoreDep) -> Response:
    if not await store.delete(memory_id):
        raise HTTPException(status_code=404, detail=MSG_ITEM_NOT_FOUND)
    return Response(status_code=204)
