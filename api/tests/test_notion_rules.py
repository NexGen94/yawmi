"""The Notion rules in code (constitution «Notion», design §11): the editable fields, the dated
note, the base value an edit expects in Notion, and the fake applier's refuse-on-mismatch contract.
"""

from datetime import UTC, date, datetime
from uuid import uuid4

import pytest

from yawmi.notion.apply import ApplyResult
from yawmi.notion.changes import (
    EDITABLE,
    FIELD_LABELS,
    FieldNotEditable,
    GoalEditOut,
    NotionChange,
    base_value,
    build_edit,
    note_for,
)
from yawmi.notion.fake import FakeNotionApplier

TODAY = date(2026, 11, 11)
APPLIED_AT = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)


def test_the_editable_fields_are_the_four_of_the_design() -> None:
    assert EDITABLE == {
        "milestone": frozenset({"done", "due_date", "evidence"}),
        "card": frozenset({"status"}),
    }
    assert FIELD_LABELS == {
        "done": "الإنجاز",
        "due_date": "الموعد",
        "evidence": "الدليل",
        "status": "الحالة",
    }


def test_the_dated_note_quotes_the_previous_and_the_new_value() -> None:
    assert (
        note_for("due_date", "2026-11-07", "2026-11-14", TODAY)
        == "2026-11-11 · يومي: الموعد من «2026-11-07» إلى «2026-11-14»"
    )
    assert note_for("done", False, True, TODAY).endswith("من «مفتوحة» إلى «منجزة»")
    assert note_for("done", True, False, TODAY).endswith("من «منجزة» إلى «مفتوحة»")


def test_an_empty_value_is_a_dash_in_the_note() -> None:
    assert note_for("evidence", None, "رابط", TODAY) == (
        "2026-11-11 · يومي: الدليل من «—» إلى «رابط»"
    )
    assert note_for("evidence", "رابط", "", TODAY).endswith("من «رابط» إلى «—»")


def test_a_date_value_is_written_as_its_iso_day() -> None:
    note = note_for("due_date", date(2026, 11, 7), date(2026, 11, 14), TODAY)
    assert note.endswith("من «2026-11-07» إلى «2026-11-14»")


@pytest.mark.parametrize(
    "field",
    [
        "title",
        "card_page_ids",
        "outcome_code",
        "outcome_codes",
        "cycle_no",
        "criterion",
        "target_date",
        "next_step",
    ],
)
@pytest.mark.parametrize("kind", ["milestone", "card"])
def test_no_other_field_is_editable(kind: str, field: str) -> None:
    with pytest.raises(FieldNotEditable):
        build_edit(kind, "p1", field, "old", "new", TODAY)


def test_a_field_of_the_other_kind_is_not_editable() -> None:
    with pytest.raises(FieldNotEditable):
        build_edit("card", "p1", "done", False, True, TODAY)
    with pytest.raises(FieldNotEditable):
        build_edit("milestone", "p1", "status", "أ", "ب", TODAY)
    with pytest.raises(FieldNotEditable):
        build_edit("outcome", "O1", "title", "أ", "ب", TODAY)


def test_build_edit_keeps_json_values_and_the_note() -> None:
    edit = build_edit("milestone", "p1", "due_date", date(2026, 11, 7), date(2026, 11, 14), TODAY)
    assert (edit.target_kind, edit.page_id, edit.field) == ("milestone", "p1", "due_date")
    assert (edit.old_value, edit.new_value) == ("2026-11-07", "2026-11-14")
    assert edit.note == "2026-11-11 · يومي: الموعد من «2026-11-07» إلى «2026-11-14»"


def stored(
    status: str, new_value: object, applied_at: datetime | None = None, field: str = "due_date"
) -> GoalEditOut:
    return GoalEditOut(
        id=uuid4(),
        target_kind="milestone",
        page_id="p1",
        field=field,
        old_value="2026-11-07",
        new_value=new_value,  # type: ignore[arg-type]
        note="ملاحظة",
        status=status,  # type: ignore[arg-type]
        created_at=datetime(2026, 11, 11, 8, 0, tzinfo=UTC),
        applied_at=applied_at,
        error=None,
    )


def test_the_base_value_is_the_mirror_without_an_applied_edit() -> None:
    assert base_value("2026-11-07", None, []) == "2026-11-07"
    pending = stored("pending", "2026-11-14")
    assert base_value("2026-11-07", None, [pending]) == "2026-11-07"  # pending never counts
    for status in ("superseded", "failed", "conflict"):
        assert base_value("2026-11-07", None, [stored(status, "2026-11-14")]) == "2026-11-07"


def test_the_base_value_is_the_applied_value_until_the_mirror_catches_up() -> None:
    applied = [stored("applied", "2026-11-14", APPLIED_AT)]
    assert base_value("2026-11-07", None, applied) == "2026-11-14"
    older = datetime(2026, 11, 10, 20, 0, tzinfo=UTC)
    assert base_value("2026-11-07", older, applied) == "2026-11-14"
    assert base_value("2026-11-07", APPLIED_AT, applied) == "2026-11-14"  # «لا يتجاوز»
    newer = datetime(2026, 11, 11, 9, 5, tzinfo=UTC)
    assert base_value("2026-11-20", newer, applied) == "2026-11-20"


def test_the_base_value_is_the_latest_applied_edit() -> None:
    first = stored("applied", "2026-11-14", datetime(2026, 11, 11, 9, 0, tzinfo=UTC))
    second = stored("applied", "2026-11-21", datetime(2026, 11, 11, 10, 0, tzinfo=UTC))
    assert base_value("2026-11-07", None, [second, first]) == "2026-11-21"
    assert base_value("2026-11-07", None, [first, second]) == "2026-11-21"


def change(old: object, new: object, page: str = "p1", field: str = "due_date") -> NotionChange:
    return NotionChange(
        id=uuid4(),
        target_kind="milestone",
        page_id=page,
        field=field,
        old_value=old,  # type: ignore[arg-type]
        new_value=new,  # type: ignore[arg-type]
        note="ملاحظة",
    )


async def test_the_fake_applier_writes_when_the_live_value_is_the_expected_one() -> None:
    fake = FakeNotionApplier(live={("p1", "due_date"): "2026-11-07"})
    result = await fake.apply(change("2026-11-07", "2026-11-14"))
    assert result == ApplyResult(ok=True)
    assert fake.live[("p1", "due_date")] == "2026-11-14"
    assert [c.new_value for c in fake.calls] == ["2026-11-14"]


async def test_the_fake_applier_refuses_a_live_mismatch_and_writes_nothing() -> None:
    fake = FakeNotionApplier(live={("p1", "due_date"): "2026-11-10"})
    result = await fake.apply(change("2026-11-07", "2026-11-14"))
    assert (result.ok, result.conflict) == (False, True)
    assert fake.live[("p1", "due_date")] == "2026-11-10"
    assert len(fake.calls) == 1


async def test_the_fake_applier_fails_on_request_and_on_an_unknown_page() -> None:
    fake = FakeNotionApplier(live={("p1", "due_date"): "2026-11-07"}, fail_on={"p1"})
    result = await fake.apply(change("2026-11-07", "2026-11-14"))
    assert (result.ok, result.conflict) == (False, False) and result.error
    assert fake.live[("p1", "due_date")] == "2026-11-07"
    missing = await FakeNotionApplier().apply(change("2026-11-07", "2026-11-14"))
    assert (missing.ok, missing.conflict) == (False, False) and missing.error
