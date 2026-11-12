"""`GET`, `PUT`, `DELETE /v1/indicators`: manage habit and goal indicators."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Request, Response, status

from yawmi.auth.deps import require_kind
from yawmi.db.pool import get_pool
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED
from yawmi.indicators.models import IndicatorIn, IndicatorIO, IndicatorList
from yawmi.indicators.store import AsyncpgIndicatorStore, IndicatorStore

USER_KINDS = ("iphone", "watch", "web")

router = APIRouter(
    prefix="/v1",
    tags=["indicators"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


def get_indicator_store(request: Request) -> IndicatorStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: IndicatorStore | None = getattr(request.app.state, "indicators", None)
    return injected if injected is not None else AsyncpgIndicatorStore(get_pool())


IndicatorDep = Annotated[IndicatorStore, Depends(get_indicator_store)]


@router.get(
    "/indicators",
    summary="قائمة المؤشرات",
    response_model=IndicatorList,
)
async def list_indicators(store: IndicatorDep) -> IndicatorList:
    items = await store.list_all()
    return IndicatorList(items=items)


@router.put(
    "/indicators/{subject_kind}/{subject_ref}",
    summary="إنشاء أو تحديث مؤشر",
    response_model=IndicatorIO,
    responses={**INVALID},
)
async def put_indicator(
    subject_kind: Annotated[Literal["habit", "goal"], Path()],
    subject_ref: Annotated[str, Path()],
    item: IndicatorIn,
    store: IndicatorDep,
) -> IndicatorIO:
    if item.subject_kind != subject_kind or item.subject_ref != subject_ref:
        item = item.model_copy(update={"subject_kind": subject_kind, "subject_ref": subject_ref})
    return await store.put(item)


@router.delete(
    "/indicators/{subject_kind}/{subject_ref}",
    summary="حذف مؤشر",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={**INVALID},
)
async def delete_indicator(
    subject_kind: Annotated[Literal["habit", "goal"], Path()],
    subject_ref: Annotated[str, Path()],
    store: IndicatorDep,
) -> Response:
    await store.delete(subject_kind, subject_ref)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
