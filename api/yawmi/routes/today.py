"""`GET /v1/today` (the morning view) and `GET /v1/overview` (the full picture).

Both are read-only. The local day is the server's day in Asia/Riyadh. The pieces are built by
`yawmi.today.assemble` from rows read through a `TodayReader`; this module only wires them.
`priorities` stays empty until the insight service fills it, and `cards[].habits` until the
habit routes do (task 10b); both extensions are additive.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from yawmi.auth.deps import require_kind
from yawmi.db.pool import get_pool
from yawmi.domain.days import DEFAULT_TZ, day_key
from yawmi.errors import FORBIDDEN, UNAUTHORIZED
from yawmi.events import models as event_models
from yawmi.today.assemble import (
    OverviewOut,
    TodayOut,
    build_cards,
    build_habits_due,
    build_health,
    build_outcomes,
    build_plan,
    trend_window,
)
from yawmi.today.reader import AsyncpgTodayReader, TodayReader

READER_KINDS = ("iphone", "watch", "web")

router = APIRouter(
    prefix="/v1",
    tags=["today"],
    dependencies=[Depends(require_kind(*READER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


def get_today_reader(request: Request) -> TodayReader:
    """The reader injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: TodayReader | None = getattr(request.app.state, "today", None)
    return injected if injected is not None else AsyncpgTodayReader(get_pool())


TodayReaderDep = Annotated[TodayReader, Depends(get_today_reader)]


@router.get(
    "/today",
    summary="اليوم: العادات المستحقة والصحة والخطة",
    description=(
        "اليوم المحلي بتوقيت الرياض. `habits_due` العادات المجدولة اليوم؛ و`health` درجات اليوم "
        "واتجاه سبعة أيام (يوم بلا ساعة «ناقص» لا صفر)؛ و`plan` الدورة الحالية من مرآة Notion."
    ),
)
async def get_today(reader: TodayReaderDep) -> TodayOut:
    day = day_key(event_models.server_now(), DEFAULT_TZ)
    first, last = trend_window(day)
    return TodayOut(
        day=day,
        habits_due=build_habits_due(
            day, await reader.active_habits(day), await reader.habit_logs(day, day)
        ),
        priorities=[],
        health=build_health(day, await reader.daily_metrics(first, last)),
        plan=build_plan(day, await reader.cycles(), await reader.milestones()),
    )


@router.get(
    "/overview",
    summary="الصورة الكاملة: المخرجات والبطاقات",
    description=(
        "المخرجات O1–O12 بنسبة إنجاز محطاتها (كما في Notion، والعادات لا تغيّرها) وأقرب محطة "
        "مفتوحة، والبطاقات بمخرجاتها."
    ),
)
async def get_overview(reader: TodayReaderDep) -> OverviewOut:
    milestones = await reader.milestones()
    return OverviewOut(
        outcomes=build_outcomes(await reader.goals(), milestones),
        cards=build_cards(await reader.cards()),
    )
