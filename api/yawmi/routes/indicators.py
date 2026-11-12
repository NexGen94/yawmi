"""`GET`, `PUT`, `DELETE /v1/indicators`: manage habit and goal indicators."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, Response, status
from fastapi.exceptions import RequestValidationError

from yawmi.auth.deps import USER_KINDS, require_kind
from yawmi.db.pool import get_pool
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED
from yawmi.habits.models import Ref
from yawmi.indicators.models import IndicatorIO, IndicatorList, SubjectKind
from yawmi.indicators.store import AsyncpgIndicatorStore, IndicatorStore

router = APIRouter(
    prefix="/v1",
    tags=["indicators"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)

_SUBJECT_MISMATCH = "موضوع المؤشر في الجسم يخالف موضوعه في المسار"


def get_indicator_store(request: Request) -> IndicatorStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: IndicatorStore | None = getattr(request.app.state, "indicators", None)
    return injected if injected is not None else AsyncpgIndicatorStore(get_pool())


IndicatorDep = Annotated[IndicatorStore, Depends(get_indicator_store)]
KindPath = Annotated[SubjectKind, Path()]
RefPath = Annotated[Ref, Path()]


@router.get(
    "/indicators",
    summary="قائمة المؤشرات",
    response_model=IndicatorList,
)
async def list_indicators(store: IndicatorDep) -> IndicatorList:
    return IndicatorList(items=await store.list())


@router.put(
    "/indicators/{subject_kind}/{subject_ref}",
    summary="إنشاء أو تحديث مؤشر",
    description="الموضوع من المسار، ويكرّره الجسم: إن خالفه فـ422. و`id` و`updated_at` يضعهما الخادم.",
    response_model=IndicatorIO,
    responses={**INVALID},
)
async def put_indicator(
    subject_kind: KindPath, subject_ref: RefPath, item: IndicatorIO, store: IndicatorDep
) -> IndicatorIO:
    for field, url_value in (("subject_kind", subject_kind), ("subject_ref", subject_ref)):
        if getattr(item, field) != url_value:
            raise RequestValidationError(
                [{"loc": ("body", field), "type": "subject_mismatch", "msg": _SUBJECT_MISMATCH}]
            )
    return await store.put(item)


@router.delete(
    "/indicators/{subject_kind}/{subject_ref}",
    summary="حذف مؤشر",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={**INVALID},
)
async def delete_indicator(
    subject_kind: KindPath, subject_ref: RefPath, store: IndicatorDep
) -> Response:
    await store.delete(subject_kind, subject_ref)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
