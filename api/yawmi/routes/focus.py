"""`/v1/focus/plans` and `GET /v1/focus/sessions`: focus blocks the user plans, and the sessions
the `focus_ended` events became (design §7.1, §7.5).

A plan is never deleted: `PATCH active = false` hides it from the default list, and `?all=true`
shows it again. The schedule (a weekday mask and a start time) is both or neither, after a patch
as well as on creation. The sessions are read-only, in a range of 400 days at most.
"""

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError

from yawmi.auth.deps import USER_KINDS, require_kind
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.focus.deps import FocusStoreDep
from yawmi.focus.models import (
    FocusPlanIO,
    FocusPlanList,
    FocusPlanOut,
    FocusPlanPatch,
    FocusSessionList,
    schedule_is_complete,
)
from yawmi.focus.store import UnknownHabit
from yawmi.journal import check_date_range

PLAN_NOT_FOUND = "الخطة غير موجودة"
EMPTY_PATCH = "لا حقل للتعديل"
HABIT_UNKNOWN = "العادة غير موجودة"
SCHEDULE_INCOMPLETE = "القناع والوقت معاً أو لا شيء"

router = APIRouter(
    prefix="/v1/focus",
    tags=["focus"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


def _unknown_habit() -> RequestValidationError:
    return RequestValidationError(
        [{"loc": ("body", "habit_code"), "type": "unknown_habit", "msg": HABIT_UNKNOWN}]
    )


@router.get(
    "/plans",
    summary="خطط التركيز، المفضلة أولاً",
    description="الفعّالة وحدها افتراضياً، و`all=true` تضيف المعطّلة.",
    response_model=FocusPlanList,
    responses={**INVALID},
)
async def list_plans(
    store: FocusStoreDep,
    all_: Annotated[bool, Query(alias="all", description="تشمل الخطط المعطّلة")] = False,
) -> FocusPlanList:
    return FocusPlanList(items=await store.plans(all_))


@router.post(
    "/plans",
    summary="إنشاء خطة تركيز",
    description=(
        "`minutes` من 5 إلى 240. `weekday_mask` و`start_time` معاً أو لا شيء. `habit_code` "
        "عادة قائمة، وإلا 422 `unknown_habit`."
    ),
    response_model=FocusPlanOut,
    status_code=status.HTTP_201_CREATED,
    responses={**INVALID},
)
async def create_plan(body: FocusPlanIO, store: FocusStoreDep) -> FocusPlanOut:
    try:
        return await store.add_plan(body)
    except UnknownHabit:
        raise _unknown_habit() from None


@router.patch(
    "/plans/{plan_id}",
    summary="تعديل خطة تركيز أو تعطيلها",
    description="تتغيّر الحقول المرسَلة وحدها. لا حذف: `active = false` يخفيها.",
    response_model=FocusPlanOut,
    responses={404: {"model": ErrorDetail, "description": PLAN_NOT_FOUND}, **INVALID},
)
async def patch_plan(plan_id: UUID, body: FocusPlanPatch, store: FocusStoreDep) -> FocusPlanOut:
    changes = body.changes()
    if not changes:
        raise RequestValidationError(
            [{"loc": ("body",), "type": "empty_patch", "msg": EMPTY_PATCH}]
        )
    current = next((p for p in await store.plans(True) if p.id == plan_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail=PLAN_NOT_FOUND)
    merged = {**current.model_dump(), **changes}
    if not schedule_is_complete(merged["weekday_mask"], merged["start_time"]):
        raise RequestValidationError(
            [{"loc": ("body",), "type": "schedule_incomplete", "msg": SCHEDULE_INCOMPLETE}]
        )
    try:
        saved = await store.patch_plan(plan_id, changes)
    except UnknownHabit:
        raise _unknown_habit() from None
    if saved is None:
        raise HTTPException(status_code=404, detail=PLAN_NOT_FOUND)
    return saved


@router.get(
    "/sessions",
    summary="جلسات التركيز في مدى زمني",
    description="الصفوف المسقطة من أحداث `focus_ended` بين `from` و`to` (400 يوم على الأكثر).",
    response_model=FocusSessionList,
    responses={**INVALID},
)
async def list_sessions(
    store: FocusStoreDep,
    first: Annotated[date, Query(alias="from", description="أول يوم في المدى")],
    last: Annotated[date, Query(alias="to", description="آخر يوم في المدى")],
) -> FocusSessionList:
    check_date_range(first, last)
    return FocusSessionList(items=await store.sessions(first, last))
