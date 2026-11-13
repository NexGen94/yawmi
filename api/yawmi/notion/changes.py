"""The rules of a goal edit (constitution «Notion», design §11), in code.

* Only four fields are editable (`EDITABLE`): a milestone's `done`, `due_date` and `evidence`, and
  a card's `status`. Everything else, the relations first (`card_page_ids`, `outcome_code`,
  `outcome_codes`), is refused with `FieldNotEditable`: an edit never replaces a relation, never
  renames, never deletes (closing is `done` or a status), and never changes the schema.
* Every edit carries a dated note quoting the previous value (`note_for`).
* An edit expects a value in Notion (`old_value`): the base value the owner saw under any pending
  edit (`base_value`, ruling R-3). The applier refuses when the live value differs.

Values travel as JSON: a boolean for `done`, an ISO day (`YYYY-MM-DD`) for `due_date`, text for
`evidence` and `status`. `None` is an empty value.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

TargetKind = Literal["milestone", "card"]
EditStatus = Literal["pending", "applied", "failed", "superseded", "conflict", "cancelled"]
# the states a cancel closes: a conflict is never applied, so it must be closable too
CANCELLABLE: tuple[EditStatus, ...] = ("pending", "conflict")
EditValue = bool | str | None

EDITABLE: dict[str, frozenset[str]] = {
    "milestone": frozenset({"done", "due_date", "evidence"}),
    "card": frozenset({"status"}),
}
FIELD_LABELS = {"done": "الإنجاز", "due_date": "الموعد", "evidence": "الدليل", "status": "الحالة"}
EMPTY = "—"


class FieldNotEditable(ValueError):
    """The field is not one of `EDITABLE[target_kind]`."""

    def __init__(self, target_kind: str, field: str) -> None:
        super().__init__(f"{target_kind}.{field} is not editable")
        self.target_kind = target_kind
        self.field = field


def check_editable(target_kind: str, field: str) -> None:
    """Raise `FieldNotEditable` unless `field` may be edited on a `target_kind`."""
    if field not in EDITABLE.get(target_kind, frozenset()):
        raise FieldNotEditable(target_kind, field)


def to_json(value: object) -> EditValue:
    """The JSON form of a field value: a `date` becomes its ISO day, the rest is kept."""
    if isinstance(value, date):
        return value.isoformat()
    if value is None or isinstance(value, bool | str):
        return value
    raise TypeError(f"not an edit value: {type(value).__name__}")


def from_json(field: str, value: EditValue) -> object:
    """The row form of a JSON value: `due_date` back to a `date`."""
    if field == "due_date" and isinstance(value, str):
        return date.fromisoformat(value)
    return value


def _shown(value: object) -> str:
    if isinstance(value, bool):
        return "منجزة" if value else "مفتوحة"
    if isinstance(value, date):
        return value.isoformat()
    if value is None or value == "":
        return EMPTY
    return str(value)


def note_for(field: str, old: object, new: object, today: date) -> str:
    """`{YYYY-MM-DD} · يومي: {label} من «{old}» إلى «{new}»` (design §11)."""
    return (
        f"{today.isoformat()} · يومي: {FIELD_LABELS[field]} من «{_shown(old)}» إلى «{_shown(new)}»"
    )


def cancel_note(today: date) -> str:
    """The dated line a cancel appends to an edit's note (nothing is deleted)."""
    return f"\n{today.isoformat()} · يومي: إلغاء التعديل"


@dataclass(frozen=True)
class GoalEdit:
    """A new edit, before it is stored: what `build_edit` checks and builds."""

    target_kind: TargetKind
    page_id: str
    field: str
    old_value: EditValue
    new_value: EditValue
    note: str


def build_edit(
    target_kind: str, page_id: str, field: str, old: object, new: object, today: date
) -> GoalEdit:
    """A checked edit with its dated note; `FieldNotEditable` for any field outside `EDITABLE`."""
    check_editable(target_kind, field)
    return GoalEdit(
        target_kind=target_kind,  # type: ignore[arg-type]  # checked by `check_editable`
        page_id=page_id,
        field=field,
        old_value=to_json(old),
        new_value=to_json(new),
        note=note_for(field, old, new, today),
    )


class GoalEditOut(BaseModel):
    """A stored edit (design §7.4). `old_value` is the value expected in Notion."""

    id: UUID
    target_kind: TargetKind
    page_id: str
    field: str
    old_value: EditValue = Field(description="القيمة المتوقعة في Notion لحظة التعديل")
    new_value: EditValue
    note: str = Field(description="الملاحظة المؤرخة بالقيمة السابقة")
    status: EditStatus
    created_at: datetime
    applied_at: datetime | None
    error: str | None


class GoalEditList(BaseModel):
    items: list[GoalEditOut]


class NotionChange(BaseModel):
    """One property write for an applier: one field of one page (design §7.4)."""

    id: UUID
    target_kind: TargetKind
    page_id: str
    field: str
    old_value: EditValue = Field(description="القيمة المتوقعة في Notion: يرفض المطبّق إن خالفتها")
    new_value: EditValue
    note: str


class NotionChangeList(BaseModel):
    items: list[NotionChange]


def change_of(edit: GoalEditOut) -> NotionChange:
    return NotionChange(
        id=edit.id,
        target_kind=edit.target_kind,
        page_id=edit.page_id,
        field=edit.field,
        old_value=edit.old_value,
        new_value=edit.new_value,
        note=edit.note,
    )


def latest_applied(edits: Sequence[GoalEditOut]) -> GoalEditOut | None:
    """The applied edit with the latest `applied_at` (then the latest creation), if any."""
    applied = [e for e in edits if e.status == "applied" and e.applied_at is not None]
    return max(applied, key=lambda e: (e.applied_at, e.created_at), default=None)


def mirror_caught_up(mirror_edited_at: datetime | None, applied_at: datetime) -> bool:
    """Rule 3 of the overlay: the mirror holds a row edited in Notion after the edit was applied."""
    return mirror_edited_at is not None and mirror_edited_at > applied_at


def base_value(
    mirror_value: object, mirror_edited_at: datetime | None, edits: Sequence[GoalEditOut]
) -> object:
    """The value the owner sees under any pending edit (R-3): the latest applied `new_value`
    while the mirror has not caught up with it (overlay rule 2), else the mirror's value.

    `edits` are the edits of one field of one page; a pending edit never counts. The result is
    the `old_value` of a new edit, and what the cheap check compares before calling an applier.
    """
    applied = latest_applied(edits)
    if applied is not None and not mirror_caught_up(mirror_edited_at, applied.applied_at):  # type: ignore[arg-type]
        return applied.new_value
    return to_json(mirror_value)


def shown_value(
    mirror_value: object, mirror_edited_at: datetime | None, edits: Sequence[GoalEditOut]
) -> tuple[EditValue, bool]:
    """The value `GET /v1/goals` shows for one field (ruling 7), and whether it is pending:
    the pending `new_value` first, then the base value."""
    pending = next((e for e in edits if e.status == "pending"), None)
    if pending is not None:
        return pending.new_value, True
    return to_json(base_value(mirror_value, mirror_edited_at, edits)), False
