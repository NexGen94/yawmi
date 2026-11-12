"""`POST /v1/goals/{ref}/to-habit`: suggest a habit that serves a goal, without saving it.

`ref` is the Notion page id of a milestone or of a card in the Raqib mirror (milestones are
looked up first). The draft takes the mirror's title, `goal_ref = ref`, and the outcome of the
milestone (or the first outcome of the card). With a `kpi_code`, the KPI's type in `raqib.kpis`
(`kpi_prefill_kind`, owner decision 5) decides the target:

* cumulative over the horizon (`CUMULATIVE_KPIS`: a total reached by the deadline): with a
  deadline (the milestone's `due_date`, else the outcome's `target_date` in `raqib.goals`), a
  `count` habit whose target per period spreads what is left (the target minus the newest
  reading on or before today, or 0) over the periods up to the deadline (`goal_prefill`);
* a count per period (direction `up`, one target, daily/weekly/monthly, not a rate, average,
  level or sum of money): a habit whose target is the KPI's own `target` when the requested
  `period` matches the KPI's frequency (`per_period_prefill`); the reading and the deadline play
  no part. A KPI in minutes gives a `duration` habit in `min`, one in sessions a `count` in
  `session`, any other a `count` with no unit (`kpi_habit_shape`);
* anything else (down, band, rates, averages, levels, money), or a period that does not match:
  no numeric target.

Without a numeric target the draft is a daily yes/no habit with target 1. Nothing is written:
the Notion completion of the goal never changes because of a habit.

An unknown `kpi_code` is a 422 on `["body", "kpi_code"]` (an unknown `ref` stays a 404). A
draft is always one that `POST /v1/habits` accepts: a blank mirror title becomes «عادة جديدة»
and a long one is cut to 200 characters, and a KPI target that is not a finite number, or a
computed target above the limit (100 000), falls back to the daily yes/no draft.
"""

import math
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field

from yawmi.auth.deps import SettingsDep, require_kind
from yawmi.db.pool import get_pool
from yawmi.domain.days import DEFAULT_TZ, day_key
from yawmi.domain.habits import (
    HabitKind,
    goal_prefill,
    kpi_habit_shape,
    kpi_prefill_kind,
    per_period_prefill,
)
from yawmi.domain.periods import Period, WeekStart
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.events import models as event_models
from yawmi.habits.models import HabitDraft
from yawmi.habits.store import AsyncpgMirrorReader, KpiRef, MirrorReader
from yawmi.text import StorableText, is_storable

USER_KINDS = ("iphone", "watch", "web")
DEFAULT_KPI_PERIOD: Period = "week"
NOT_FOUND_MESSAGE = "لا محطة ولا بطاقة بهذا المعرّف"
KPI_UNKNOWN_MESSAGE = "لا مؤشر بهذا الرمز"
DEFAULT_TITLE = "عادة جديدة"
MAX_TITLE = 200
MAX_TARGET = 100_000
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
        default=None, description="رمز مؤشر من مؤشرات الخطة؛ رمز مجهول يُرفض (422)"
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


async def _kpi_target(
    mirror: MirrorReader,
    code: str,
    kpi: KpiRef,
    period: Period,
    today: date,
    deadline: date | None,
    week_start: WeekStart,
) -> tuple[HabitKind, str, float] | None:
    """The habit's kind, unit and numeric target for the KPI, or `None` for the yes/no draft.

    A target that is not a finite number above zero and at most `MAX_TARGET` is `None` too, so a
    draft is always one that `POST /v1/habits` accepts.
    """
    goal = math.nan if kpi.target is None else float(kpi.target)  # Decimal NaN -> nan
    if not math.isfinite(goal):
        return None
    value: float | None = None
    kind, unit = "count", ""
    match kpi_prefill_kind(code, kpi.direction, kpi.unit, goal, kpi.frequency):
        case "cumulative":
            if deadline is None:
                return None
            if code == "books_done":
                deadline = min(deadline, date(today.year, 12, 31))
                current = await mirror.latest_reading(code, today, since=date(today.year, 1, 1))
            else:
                current = await mirror.latest_reading(code, today)
            reading = 0.0 if current is None else float(current)
            if not math.isfinite(reading):
                reading = 0.0
            if not math.isfinite(goal - reading):
                return None
            value = float(goal_prefill(goal, reading, today, deadline, period, week_start))
        case "per_period":  # the reading and the deadline play no part
            value = per_period_prefill(goal, kpi.frequency, period)
            kind, unit = kpi_habit_shape(kpi.unit, value, period)
    if value is None or not 0 < value <= MAX_TARGET:
        return None
    return kind, unit, value


@router.post(
    "/{ref}/to-habit",
    summary="اقتراح عادة لهدف (لا تُحفظ)",
    description=(
        "`ref` معرّف صفحة محطة أو بطاقة في المرآة. مع مؤشر تراكمي (مجموع يُبلغ بالموعد) وموعد: "
        "عادة عدّ هدفها في الفترة = ⌈(الهدف − آخر قراءة) ÷ عدد الفترات حتى الموعد⌉. ومع مؤشر عدّ "
        "في الفترة (صاعد بهدف واحد، يومي أو أسبوعي أو شهري، وليس نسبة ولا متوسطاً ولا مستوى ولا "
        "مالاً): عادة هدفها هدف المؤشر نفسه إن طابقت الفترة تواتره، مدةً بالدقائق لمؤشر بالدقائق "
        "وعدّاً لغيره. وغير ذلك (نازل، نطاق، نسبة، متوسط، مستوى، مال، أو فترة لا تطابق): عادة "
        "يومية بنعم أو لا هدفها 1. لا تغيّر نسبة إنجاز Notion."
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
    kind, unit, period, target = "boolean", "", "day", 1.0
    if request.kpi_code is not None:
        kpi = await mirror.kpi(request.kpi_code)
        if kpi is None:
            raise RequestValidationError(
                [{"loc": ("body", "kpi_code"), "type": "kpi_unknown", "msg": KPI_UNKNOWN_MESSAGE}]
            )
        prefill = await _kpi_target(
            mirror, request.kpi_code, kpi, request.period, today, deadline, settings.week_start
        )
        if prefill is not None:
            kind, unit, target = prefill
            period = request.period
    return HabitDraft(
        title_ar=title.strip()[:MAX_TITLE].strip() or DEFAULT_TITLE,
        goal_ref=ref,
        outcome=outcome,
        ac_ref=None,
        kind=kind,  # type: ignore[arg-type]
        unit=unit,  # type: ignore[arg-type]
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
