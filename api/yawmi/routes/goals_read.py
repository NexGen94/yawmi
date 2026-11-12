"""`GET /v1/goals` (the whole plan) and `GET /v1/goals/{ref}/pace` (design §7.4, §9.4).

Read-only. The day is the Riyadh day. The mirror of Notion is empty until its sync is deployed:
then `GET /v1/goals` is 200 with empty lists and `synced_at: null`, never an error. Nothing is
written to Notion or to the mirror.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from yawmi.auth.deps import USER_KINDS, SettingsDep, require_kind
from yawmi.domain.days import DEFAULT_TZ, day_key
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.events import models as event_models
from yawmi.goals.deps import GoalsReaderDep, SourcesDep
from yawmi.goals.models import GoalsOut, PaceOut
from yawmi.goals.service import load_goals, load_pace
from yawmi.text import is_storable

NOT_FOUND_MESSAGE = "لا مخرج بهذا الرمز"
NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": NOT_FOUND_MESSAGE},
}

router = APIRouter(
    prefix="/v1/goals",
    tags=["goals"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


@router.get(
    "",
    summary="الأهداف كاملة: المخرجات والدورات والمحطات والبطاقات",
    description=(
        "قراءة كاملة من مرآة Notion مع العادات والمهام والمؤشرات. مرآة فارغة (قبل نشر المزامنة) "
        "تعطي قوائم فارغة و`synced_at: null`. `completion` المخرج المحطات المنجزة ÷ كلها كما في "
        "Notion، ولا تغيّرها العادات. `target_date` و`next_step` للبطاقة من خاصيتين مسمّاتين "
        "فقط، ولا يُقرأ غيرهما من خصائصها."
    ),
)
async def get_goals(sources: SourcesDep, settings: SettingsDep) -> GoalsOut:
    today = day_key(event_models.server_now(), DEFAULT_TZ)
    return await load_goals(sources, today, settings.week_start)


@router.get(
    "/{ref}/pace",
    summary="خط وتيرة مخرج",
    description=(
        "الأساس `kpi` لمخرج له مؤشر تراكمي أو صاعد بهدف واحد (`kpi` يختار واحداً منها)، وغير ذلك "
        "`milestones` (المنجزة من كلها، من 2026-10-31). `days_left` سالب بعد الموعد."
    ),
    responses={**NOT_FOUND, **INVALID},
)
async def get_pace(
    ref: Annotated[str, Path(max_length=64, description="رمز المخرج")],
    goals: GoalsReaderDep,
    kpi: Annotated[str | None, Query(max_length=64, description="رمز مؤشر المخرج")] = None,
) -> PaceOut:
    today = day_key(event_models.server_now(), DEFAULT_TZ)
    pace = await load_pace(goals, ref, kpi, today) if is_storable(ref) else None
    if pace is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND_MESSAGE)
    return pace
