"""`GET /v1/habit-logs`: habit logs in a bounded date range (at most 400 days)."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel

from yawmi.auth.deps import require_kind
from yawmi.db.pool import get_pool
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED
from yawmi.events.project import EARLIEST, LATEST
from yawmi.text import is_storable
from yawmi.today.reader import AsyncpgTodayReader, TodayReader

READER_KINDS = ("iphone", "watch", "web")
MAX_RANGE_DAYS = 400

_DAY_OUT_OF_RANGE = "اليوم خارج النطاق المعقول"
_INVALID_RANGE = "نهاية المدى تسبق بدايته"
_RANGE_TOO_LARGE = "المدى يتجاوز 400 يوم"
_INVALID_CODE = "رمز العادة غير صالح"

router = APIRouter(
    prefix="/v1",
    tags=["habits"],
    dependencies=[Depends(require_kind(*READER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


class HabitLogOut(BaseModel):
    habit_code: str
    day: date
    value: float | None
    status: str


class HabitLogList(BaseModel):
    logs: list[HabitLogOut]


def get_today_reader(request: Request) -> TodayReader:
    injected: TodayReader | None = getattr(request.app.state, "today", None)
    return injected if injected is not None else AsyncpgTodayReader(get_pool())


TodayReaderDep = Annotated[TodayReader, Depends(get_today_reader)]


def check_date_range(first: date, last: date) -> tuple[date, date]:
    for name, value in (("from", first), ("to", last)):
        if not EARLIEST.date() <= value < LATEST.date():
            raise RequestValidationError(
                [{"loc": ("query", name), "type": "day_out_of_range", "msg": _DAY_OUT_OF_RANGE}]
            )
    if last < first:
        raise RequestValidationError(
            [{"loc": ("query", "to"), "type": "invalid_range", "msg": _INVALID_RANGE}]
        )
    if (last - first).days > MAX_RANGE_DAYS:
        raise RequestValidationError(
            [{"loc": ("query", "to"), "type": "range_too_large", "msg": _RANGE_TOO_LARGE}]
        )
    return first, last


@router.get(
    "/habit-logs",
    summary="سجلات العادات في مدى زمني",
    description="سجلات العادات بين `from` و`to` (400 يوم على الأكثر)، مع حصر اختياري برمز العادة `code`.",
    responses={**INVALID},
)
async def list_habit_logs(
    reader: TodayReaderDep,
    first: Annotated[date, Query(alias="from", description="أول يوم في المدى")],
    last: Annotated[date, Query(alias="to", description="آخر يوم في المدى")],
    code: Annotated[
        str | None, Query(min_length=1, max_length=64, description="رمز العادة")
    ] = None,
) -> HabitLogList:
    check_date_range(first, last)
    if code is not None and not is_storable(code):
        raise RequestValidationError(
            [{"loc": ("query", "code"), "type": "invalid_code", "msg": _INVALID_CODE}]
        )
    rows = await reader.habit_logs_range(first, last, code)
    return HabitLogList(
        logs=[
            HabitLogOut(
                habit_code=r.habit_code,
                day=r.day,
                value=float(r.value) if r.value is not None else None,
                status=r.status or "done",
            )
            for r in rows
        ]
    )
