"""`GET /v1/breath/sessions`: the breathing sessions the `breath_ended` events became, each with
how the user felt afterwards when they said (design §7.1, §7.5, §7.6).

Read-only, in a range of 400 days at most. The `pattern` is free text of 1 to 64 characters as the
event carries it; the closed set of patterns is the client's and the `breath_prefs` setting's.
"""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from yawmi.auth.deps import USER_KINDS, require_kind
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED
from yawmi.focus.deps import FocusStoreDep
from yawmi.focus.models import BreathSessionList
from yawmi.journal import check_date_range

router = APIRouter(
    prefix="/v1/breath",
    tags=["breath"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


@router.get(
    "/sessions",
    summary="جلسات التنفّس في مدى زمني",
    description="الصفوف المسقطة من أحداث `breath_ended` بين `from` و`to` (400 يوم على الأكثر).",
    response_model=BreathSessionList,
    responses={**INVALID},
)
async def list_breath_sessions(
    store: FocusStoreDep,
    first: Annotated[date, Query(alias="from", description="أول يوم في المدى")],
    last: Annotated[date, Query(alias="to", description="آخر يوم في المدى")],
) -> BreathSessionList:
    check_date_range(first, last)
    return BreathSessionList(items=await store.breath_sessions(first, last))
