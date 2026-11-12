"""Goal edits: `PATCH /v1/milestones/{page_id}`, `PATCH /v1/cards/{page_id}`, `GET /v1/goal-edits`
and `POST /v1/goal-edits/{edit_id}/cancel` (design §7.1 and §11).

An edit is a row in `yawmi.goal_edits` over the Notion mirror; the mirror is never written. The
rules of the constitution («Notion») hold in code: only the four fields of `EDITABLE` (anything
else, the relations first, is a 422 `field_not_editable` decided by `check_editable`), no delete
route (a milestone closes with `done`, a card with a status), no new status (a card's status must
be one the mirror already has, else 422 `status_unknown`), and a dated note quoting the previous
value on every edit.

The previous value (`old_value`) is the base value the owner saw (R-3): the latest applied value
while the mirror has not caught up with it, else the mirror's. A new edit supersedes the pending
one of the same field; a value equal to what is shown writes nothing, and a value equal to the
base value drops the pending edit. Cancelling closes a pending or conflicting edit as `cancelled`
with a dated line added to its note; nothing is deleted.
"""

from datetime import date
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool
from pydantic_core import PydanticCustomError

from yawmi.auth.deps import USER_KINDS, CurrentDevice, SettingsDep, require_kind
from yawmi.domain.days import DEFAULT_TZ, day_key
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.events import models as event_models
from yawmi.goals.deps import EditStoreDep, SourcesDep
from yawmi.goals.edits_store import EditStore
from yawmi.goals.models import CardFull, MilestoneFull
from yawmi.goals.reader import CardFullRow, MilestoneFullRow
from yawmi.goals.service import load_goals
from yawmi.notion.changes import (
    EditStatus,
    FieldNotEditable,
    GoalEditList,
    GoalEditOut,
    base_value,
    build_edit,
    cancel_note,
    check_editable,
    shown_value,
    to_json,
)
from yawmi.text import StorableText, is_storable

FIRST_DUE = date(2026, 10, 31)
LAST_DUE = date(2031, 12, 31)
MAX_EVIDENCE = 500

PAGE_NOT_FOUND = "لا صفحة بهذا المعرّف في المرآة"
EDIT_NOT_FOUND = "التعديل غير موجود"
NOT_CANCELLABLE = "لا يُلغى إلا تعديل معلّق أو متعارض"
EMPTY_PATCH = "لا حقل للتعديل"
NOT_EDITABLE = "الحقل لا يُعدَّل من يومي"
STATUS_UNKNOWN = "حالة ليست بين حالات البطاقات في المرآة"
DUE_OUT_OF_RANGE = "الموعد خارج مدى الخطة (2026-10-31 إلى 2031-12-31)"

NOT_FOUND_PAGE: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": PAGE_NOT_FOUND},
}
EDIT_RESPONSES: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": EDIT_NOT_FOUND},
    409: {"model": ErrorDetail, "description": NOT_CANCELLABLE},
}


def _due(day: date) -> date:
    if not FIRST_DUE <= day <= LAST_DUE:
        raise PydanticCustomError("due_date_out_of_range", DUE_OUT_OF_RANGE)
    return day


DueDate = Annotated[date, AfterValidator(_due)]
Evidence = Annotated[StorableText, Field(max_length=MAX_EVIDENCE)]

# Unknown keys are let through the model and refused by the rules (`check_editable`), so a 422
# names the field (`field_not_editable`, not the generic `extra_forbidden`); the schema still
# says `additionalProperties: false`.
_EDIT_CONFIG = ConfigDict(extra="allow", json_schema_extra={"additionalProperties": False})


class MilestoneEdit(BaseModel):
    """At least one field. `done` closes or reopens a milestone (no deletion); `due_date` lies in
    the plan (2026-10-31 to 2031-12-31); `evidence` is text up to 500 characters."""

    model_config = _EDIT_CONFIG

    done: StrictBool = None  # type: ignore[assignment]
    due_date: DueDate = None  # type: ignore[assignment]
    evidence: Evidence = None  # type: ignore[assignment]


class CardEdit(BaseModel):
    """`status`: one of the statuses the cards of the mirror already have."""

    model_config = _EDIT_CONFIG

    status: StorableText = Field(default=None, max_length=100)  # type: ignore[assignment]


router = APIRouter(
    prefix="/v1",
    tags=["goals"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


def _changes(kind: str, body: BaseModel) -> dict[str, Any]:
    """The fields to edit; 422 for any field the rules refuse, and for an empty body."""
    errors = []
    for field in body.model_extra or {}:
        try:
            check_editable(kind, field)
        except FieldNotEditable:
            errors.append(
                {"loc": ("body", field), "type": "field_not_editable", "msg": NOT_EDITABLE}
            )
    if errors:
        raise RequestValidationError(errors)
    changes = body.model_dump(include=body.model_fields_set)
    if not changes:
        raise RequestValidationError(
            [{"loc": ("body",), "type": "empty_patch", "msg": EMPTY_PATCH}]
        )
    return changes


def _same(a: object, b: object) -> bool:
    """Equal values, an empty text being the same as no value."""
    return (a in (None, "") and b in (None, "")) or (type(a) is type(b) and a == b)


async def _record(
    edits: EditStore,
    kind: str,
    row: MilestoneFullRow | CardFullRow,
    changes: dict[str, Any],
    claims: CurrentDevice,
) -> date:
    """Write one row per changed field; the Riyadh day of the edit."""
    now = event_models.server_now()
    today = day_key(now, DEFAULT_TZ)
    history = await edits.of_page(row.page_id)
    for field in sorted(changes):
        new = to_json(changes[field])
        mine = [e for e in history if e.target_kind == kind and e.field == field]
        mirror = getattr(row, field)
        shown, _ = shown_value(mirror, row.notion_edited_at, mine)
        if _same(new, shown):
            continue
        base = base_value(mirror, row.notion_edited_at, mine)
        edit = None if _same(new, base) else build_edit(kind, row.page_id, field, base, new, today)
        await edits.record(row.page_id, field, edit, claims.sub, now)
    return today


@router.patch(
    "/milestones/{page_id}",
    summary="تعديل محطة: إنجازها أو موعدها أو دليلها",
    description=(
        "حقل واحد على الأقل من ثلاثة: `done` و`due_date` (من 2026-10-31 إلى 2031-12-31، وإلا "
        "`due_date_out_of_range`) و`evidence` (حتى 500 حرف). أي حقل آخر 422 `field_not_editable`، "
        "وأولها العلاقات. يُكتب تعديلاً معلّقاً في سجل يومي بملاحظة مؤرخة بالقيمة السابقة، ولا "
        "تُكتب المرآة ولا Notion. قيمة تساوي المعروض لا تكتب شيئاً. لا حذف."
    ),
    responses={**NOT_FOUND_PAGE, **INVALID},
)
async def edit_milestone(
    page_id: str,
    body: MilestoneEdit,
    claims: CurrentDevice,
    edits: EditStoreDep,
    sources: SourcesDep,
    settings: SettingsDep,
) -> MilestoneFull:
    changes = _changes("milestone", body)
    found = is_storable(page_id) and next(
        (m for m in await sources.goals.milestones() if m.page_id == page_id), None
    )
    if not found:
        raise HTTPException(status_code=404, detail=PAGE_NOT_FOUND)
    today = await _record(edits, "milestone", found, changes, claims)
    goals = await load_goals(sources, today, settings.week_start)
    return next(m for m in goals.milestones if m.page_id == page_id)


@router.patch(
    "/cards/{page_id}",
    summary="تعديل حالة بطاقة",
    description=(
        "`status` إحدى الحالات الموجودة في بطاقات المرآة، وإلا 422 `status_unknown`: لا حالة "
        "جديدة ولا تغيير في المخطط. أي حقل آخر 422 `field_not_editable`. يُكتب تعديلاً معلّقاً "
        "بملاحظة مؤرخة. الإغلاق بالحالة، لا حذف."
    ),
    responses={**NOT_FOUND_PAGE, **INVALID},
)
async def edit_card(
    page_id: str,
    body: CardEdit,
    claims: CurrentDevice,
    edits: EditStoreDep,
    sources: SourcesDep,
    settings: SettingsDep,
) -> CardFull:
    changes = _changes("card", body)
    cards = await sources.goals.cards()
    found = is_storable(page_id) and next((c for c in cards if c.page_id == page_id), None)
    if not found:
        raise HTTPException(status_code=404, detail=PAGE_NOT_FOUND)
    if changes["status"] not in {c.status for c in cards if c.status}:
        raise RequestValidationError(
            [{"loc": ("body", "status"), "type": "status_unknown", "msg": STATUS_UNKNOWN}]
        )
    today = await _record(edits, "card", found, changes, claims)
    goals = await load_goals(sources, today, settings.week_start)
    return next(c for c in goals.cards if c.page_id == page_id)


@router.get(
    "/goal-edits",
    summary="سجل تعديلات الأهداف",
    description="الأحدث أولاً. `status` يقصره على حالة واحدة.",
    responses={**INVALID},
)
async def list_edits(
    edits: EditStoreDep,
    status: Annotated[EditStatus | None, Query(description="حالة التعديل")] = None,
) -> GoalEditList:
    return GoalEditList(items=await edits.list(status))


@router.post(
    "/goal-edits/{edit_id}/cancel",
    summary="إلغاء تعديل معلّق أو متعارض",
    description=(
        "يصير `cancelled` وتُضاف إلى ملاحظته سطر مؤرخ، ولا يُحذف شيء. تعود القيمة المعروضة إلى "
        "القيمة الأساس. المطبَّق والفاشل والمُزاح والملغى 409."
    ),
    responses={**EDIT_RESPONSES, **INVALID},
)
async def cancel_edit(edit_id: UUID, edits: EditStoreDep) -> GoalEditOut:
    today = day_key(event_models.server_now(), DEFAULT_TZ)
    done = await edits.cancel(edit_id, cancel_note(today))
    if done is not None:
        return done
    if await edits.get(edit_id) is None:
        raise HTTPException(status_code=404, detail=EDIT_NOT_FOUND)
    raise HTTPException(status_code=409, detail=NOT_CANCELLABLE)
