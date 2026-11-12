"""`/v1/habits`: list, create, edit (archive included) and the progress indicators of a habit.

Every user device (`iphone`, `watch`, `web`) may read and write; a service token may not. A
habit is never deleted: `PATCH {"active": false}` archives it and the list keeps showing it. A
system habit (`system = true`, seeded from `GOAL-2031.md`) changes only its `anchor` and
`reminders`; any other field sent with a different value is a 409.

The day is the Riyadh day (`day_key`), and the week starts on the `week_start` setting.
"""

import secrets
from datetime import date, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic_core import PydanticCustomError

from yawmi.auth.deps import SettingsDep, require_kind
from yawmi.db.pool import get_pool
from yawmi.domain.days import DEFAULT_TZ, day_key
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.events import models as event_models
from yawmi.events.project import EARLIEST
from yawmi.habits.models import (
    HabitIn,
    HabitOut,
    HabitPatch,
    domain_logs,
    from_api,
    habit_errors,
    habit_out,
    locked_changes,
    normalize,
    to_api,
)
from yawmi.habits.progress import ProgressOut, progress
from yawmi.habits.store import AsyncpgHabitStore, HabitStore, StoredHabit
from yawmi.text import is_storable

USER_KINDS = ("iphone", "watch", "web")
CODE_ATTEMPTS = 5

NOT_FOUND_MESSAGE = "العادة غير موجودة"
SYSTEM_LOCKED_MESSAGE = "عادة نظامية: يُعدَّل المرسى والتذكيرات فقط"
POLARITY_LOCKED_MESSAGE = "لا يمكن تغيير نوع العادة بعد تسجيلها"
_DAY_AHEAD = "اليوم يلي اليوم الحالي بأكثر من يوم"
_DAY_TOO_OLD = "اليوم خارج النطاق المعقول"

NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": NOT_FOUND_MESSAGE},
}
CONFLICT: dict[int | str, dict[str, Any]] = {
    409: {"model": ErrorDetail, "description": SYSTEM_LOCKED_MESSAGE},
}

router = APIRouter(
    prefix="/v1/habits",
    tags=["habits"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


def get_habit_store(request: Request) -> HabitStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: HabitStore | None = getattr(request.app.state, "habits", None)
    return injected if injected is not None else AsyncpgHabitStore(get_pool())


HabitStoreDep = Annotated[HabitStore, Depends(get_habit_store)]
Code = Annotated[str, Path(max_length=64, description="رمز العادة")]


def riyadh_today() -> date:
    return day_key(event_models.server_now(), DEFAULT_TZ)


async def _load(store: HabitStore, code: str) -> StoredHabit:
    habit = await store.get(code) if is_storable(code) else None
    if habit is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND_MESSAGE)
    return habit


def _refuse_if_invalid(values: dict[str, Any]) -> None:
    errors = habit_errors(values)
    if errors:
        raise RequestValidationError(errors)


@router.get(
    "",
    summary="كل العادات، والمؤرشفة معها",
    description="مرتبة بالرمز، ومع كل عادة تذكيراتها النشطة. المؤرشفة `active = false`.",
)
async def list_habits(store: HabitStoreDep) -> list[HabitOut]:
    return [habit_out(h) for h in await store.list_habits()]


@router.post(
    "",
    status_code=201,
    summary="إنشاء عادة",
    description=(
        "يولّد الخادم الرمز `u_` ثم 12 محرفاً ستّعشرياً، و`created_by = user`. `start_day` "
        "الافتراضي اليوم بتوقيت الرياض. القواعد بين الحقول في وصف `HabitIn`."
    ),
    responses={**INVALID},
)
async def create_habit(body: HabitIn, store: HabitStoreDep) -> HabitOut:
    values = normalize(
        {
            **body.model_dump(),
            "start_day": body.start_day or riyadh_today(),
            "system": False,
            "created_by": "user",
            "active": True,
        }
    )
    _refuse_if_invalid(values)
    for _ in range(CODE_ATTEMPTS):
        habit = from_api({**values, "code": "u_" + secrets.token_hex(6)})
        if await store.insert(habit):
            return habit_out(habit)
    raise RuntimeError("could not pick a free habit code")  # 48 random bits: not expected


async def _polarity_locked(store: HabitStore, code: str, sent: dict[str, Any]) -> bool:
    """A new `polarity` for a habit that already has a log of any status.

    The log is read before the edit, outside its lock: a log written in between is the one
    case that can slip through, and it only changes the kind of a habit with a single log.
    """
    if "polarity" not in sent or not is_storable(code):
        return False
    stored = await store.get(code)
    if stored is None or sent["polarity"] == stored.polarity:
        return False
    return bool(await store.logs(code, date.min, date.max))


@router.patch(
    "/{code}",
    response_model=HabitOut,
    summary="تعديل عادة أو أرشفتها",
    description=(
        "تعديل جزئي: تتغير الحقول المرسلة وحدها، و`null` يفرغ الحقل الذي يقبل الفراغ. "
        "`reminders` يستبدل التذكيرات كلها. الأرشفة `active = false`، ولا حذف. العادة النظامية "
        "يُعدَّل فيها `anchor` و`reminders` فقط (409 لغيرهما إن اختلفت قيمته). التذكير الباقي "
        "بوقته وقناعه يحتفظ بصفّه، والمحذوف يُعطَّل، والجديد يُضاف. و`polarity` لا يتغيّر بعد "
        "أول سجل للعادة، أياً كانت حالته: 422 بالرسالة «لا يمكن تغيير نوع العادة بعد تسجيلها»."
    ),
    responses={**NOT_FOUND, **CONFLICT, **INVALID},
)
async def patch_habit(
    code: Code, body: HabitPatch, store: HabitStoreDep
) -> HabitOut | JSONResponse:
    sent = body.model_dump(include=body.model_fields_set)
    if await _polarity_locked(store, code, sent):
        return JSONResponse(
            status_code=422,
            content={
                "detail": POLARITY_LOCKED_MESSAGE,
                "errors": [{"loc": ["body", "polarity"], "type": "polarity_locked"}],
            },
        )

    def change(stored: StoredHabit) -> StoredHabit:
        """Merge the patch into the locked habit; a 409 or 422 here aborts with nothing written."""
        current = to_api(stored)
        merged = normalize({**current, **sent})
        if stored.system and locked_changes(current, merged):
            raise HTTPException(status_code=409, detail=SYSTEM_LOCKED_MESSAGE)
        _refuse_if_invalid(merged)
        return from_api(merged)

    habit = await store.modify(code, change) if is_storable(code) else None
    if habit is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND_MESSAGE)
    return habit_out(habit)


def _today_param(
    today: Annotated[
        date | None,
        Query(description="اليوم المرجعي (الافتراضي اليوم بتوقيت الرياض)، ولا يتجاوز الغد"),
    ] = None,
) -> date:
    current = riyadh_today()
    if today is None:
        return current
    problem = None
    if today > current + timedelta(days=1):
        problem = PydanticCustomError("day_in_future", _DAY_AHEAD)
    elif today < EARLIEST.date():
        problem = PydanticCustomError("day_out_of_range", _DAY_TOO_OLD)
    if problem is not None:
        raise RequestValidationError(
            [{"loc": ("query", "today"), "type": problem.type, "msg": problem.message()}]
        )
    return today


@router.get(
    "/{code}/progress",
    summary="مؤشرات العادة",
    description=(
        "تقدّم الفترة الحالية، والقوة، والسلسلة، والتحدّي (لعادة لها نهاية)، والالتزام، ونسب آخر "
        "8 فترات. القواعد في `yawmi.domain.habits`، والهدف المتناسب للفترة المقصوصة منها."
    ),
    responses={**NOT_FOUND, **INVALID},
)
async def habit_progress(
    code: Code,
    store: HabitStoreDep,
    settings: SettingsDep,
    today: Annotated[date, Depends(_today_param)],
) -> ProgressOut:
    habit = await _load(store, code)
    logs = domain_logs(await store.logs(code, habit.start_day, today))
    return progress(habit, logs, today, settings.week_start)
