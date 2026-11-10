"""`POST /v1/goals/{ref}/to-habit`: suggest a habit that serves a goal, without saving it.

`ref` is the Notion page id of a milestone or of a card in the Raqib mirror (milestones are
looked up first). The draft takes the mirror's title, `goal_ref = ref`, and the outcome of the
milestone (or the first outcome of the card). With a `kpi_code` whose KPI has a single `target`
in `raqib.kpis` and a deadline (the milestone's `due_date`, else the outcome's `target_date` in
`raqib.goals`), it is a `count` habit whose target per period spreads what is left (the target
minus the newest reading on or before today, or 0) over the periods up to the deadline
(`goal_prefill`). Otherwise it is a daily yes/no habit with target 1. Nothing is written: the
Notion completion of the goal never changes because of a habit.
"""

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict, Field

from yawmi.auth.deps import SettingsDep, require_kind
from yawmi.db.pool import get_pool
from yawmi.domain.days import DEFAULT_TZ, day_key
from yawmi.domain.habits import goal_prefill
from yawmi.domain.periods import Period
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.events import models as event_models
from yawmi.habits.models import HabitDraft
from yawmi.habits.store import AsyncpgMirrorReader, MirrorReader
from yawmi.text import StorableText, is_storable

USER_KINDS = ("iphone", "watch", "web")
DEFAULT_KPI_PERIOD: Period = "week"
NOT_FOUND_MESSAGE = "لا محطة ولا بطاقة بهذا المعرّف"
_OUTCOMES = {f"O{n}" for n in range(1, 13)}

NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": NOT_FOUND_MESSAGE},
}

router = APIRouter(
    prefix="/v1/goals",
    tags=["goals"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


class ToHabitIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kpi_code: Annotated[StorableText, Field(min_length=1, max_length=64)] | None = Field(
        default=None, description="رمز مؤشر في `raqib.kpis`"
    )
    period: Period = Field(
        default=DEFAULT_KPI_PERIOD,
        description="فترة العادة المقترحة مع المؤشر؛ بلا مؤشر صالح تكون العادة يومية",
    )


def get_mirror(request: Request) -> MirrorReader:
    """The reader injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: MirrorReader | None = getattr(request.app.state, "mirror", None)
    return injected if injected is not None else AsyncpgMirrorReader(get_pool())


MirrorDep = Annotated[MirrorReader, Depends(get_mirror)]


def _outcome(code: str | None) -> str | None:
    return code if code in _OUTCOMES else None


@router.post(
    "/{ref}/to-habit",
    summary="اقتراح عادة لهدف (لا تُحفظ)",
    description=(
        "`ref` معرّف صفحة محطة أو بطاقة في المرآة. مع مؤشر له هدف واحد وموعد: عادة عدّ هدفها "
        "في الفترة = ⌈(الهدف − آخر قراءة) ÷ عدد الفترات حتى الموعد⌉، وإلا عادة يومية بنعم أو لا "
        "هدفها 1. لا تغيّر نسبة إنجاز Notion."
    ),
    responses={**NOT_FOUND, **INVALID},
)
async def to_habit(
    ref: Annotated[str, Path(max_length=128, description="معرّف صفحة Notion")],
    mirror: MirrorDep,
    settings: SettingsDep,
    body: ToHabitIn | None = None,
) -> HabitDraft:
    request = body or ToHabitIn()
    milestone = await mirror.milestone(ref) if is_storable(ref) else None
    card = None if milestone is not None or not is_storable(ref) else await mirror.card(ref)
    if milestone is not None:
        title, outcome = milestone.title, _outcome(milestone.outcome_code)
        deadline = milestone.due_date
    elif card is not None:
        title = card.title
        outcome = _outcome(card.outcome_codes[0]) if card.outcome_codes else None
        deadline = None
    else:
        raise HTTPException(status_code=404, detail=NOT_FOUND_MESSAGE)
    if deadline is None and outcome is not None:
        deadline = await mirror.outcome_deadline(outcome)

    today: date = day_key(event_models.server_now(), DEFAULT_TZ)
    kind, period, target = "boolean", "day", 1.0
    goal_target = None if request.kpi_code is None else await mirror.kpi_target(request.kpi_code)
    if goal_target is not None and deadline is not None:
        current = await mirror.latest_reading(request.kpi_code or "", today)
        kind, period = "count", request.period
        target = float(
            goal_prefill(
                float(goal_target),
                0.0 if current is None else float(current),
                today,
                deadline,
                request.period,
                settings.week_start,
            )
        )
    return HabitDraft(
        title_ar=title,
        goal_ref=ref,
        outcome=outcome,
        ac_ref=None,
        kind=kind,  # type: ignore[arg-type]
        unit="",
        target_per_period=target,
        period=period,  # type: ignore[arg-type]
        schedule_kind="every_day",
        weekday_mask=None,
        every_n=None,
        anchor_day=None,
        anchor="free",
        start_day=today,
        end_day=None,
        reminders=[],
    )
