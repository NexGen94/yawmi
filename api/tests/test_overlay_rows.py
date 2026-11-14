"""A structural guard for `overlay` (Task 14 N-1, parked for Task 24).

`overlay` tells a milestone from a card by one attribute (`done`) and lays an edit over a row only
for the fields the row type carries. So a reader whose row type lost `done`, `due_date`, `status`
or `notion_edited_at` would not fail loudly: its milestones would be taken for cards, or its edits
silently not shown. This test reads the real readers instead of a list of types written here: every
class of the app with a `milestones()` or `cards()` method (the protocols and every store behind
them) must return rows of a type `overlay` accepts, and each of those types must carry what the
overlay keys on. A new reader with a new row type fails here until it carries them.
"""

import importlib
import inspect
import pkgutil
import typing
from dataclasses import fields, is_dataclass

import pytest

import yawmi
from yawmi.goals.assemble import overlay
from yawmi.notion.changes import EDITABLE

ACCEPTED = overlay.__type_params__[0].__constraints__


def _row_type(annotation: object) -> type:
    """`list[Row]` gives `Row`."""
    (row,) = typing.get_args(annotation)
    assert isinstance(row, type), annotation
    return row


def _readers() -> list[tuple[str, type]]:
    """Every (`module.Class.method`, row type) of a reader method named `milestones` or `cards`."""
    found: list[tuple[str, type]] = []
    for info in pkgutil.walk_packages(yawmi.__path__, "yawmi."):
        module = importlib.import_module(info.name)
        for name, cls in vars(module).items():
            if not inspect.isclass(cls) or cls.__module__ != module.__name__:
                continue
            for method in ("milestones", "cards"):
                if method in vars(cls):
                    hints = typing.get_type_hints(vars(cls)[method])
                    found.append((f"{module.__name__}.{name}.{method}", _row_type(hints["return"])))
    return found


READERS = _readers()


def test_the_scan_finds_the_readers_it_is_for() -> None:
    names = {name for name, _ in READERS}
    for expected in (
        "yawmi.goals.reader.GoalsReader.milestones",
        "yawmi.goals.reader.GoalsReader.cards",
        "yawmi.today.memory.InMemoryTodayReader.milestones",
        "yawmi.today.reader.AsyncpgTodayReader.cards",
        "yawmi.goals.reader.AsyncpgGoalsReader.milestones",
        "yawmi.ai.reader.GroundingReader.milestones",
    ):
        assert expected in names, sorted(names)
    assert len(READERS) >= 12


@pytest.mark.parametrize(("name", "row"), READERS, ids=[n for n, _ in READERS])
def test_every_reader_returns_a_row_type_that_overlay_accepts(name: str, row: type) -> None:
    assert row in ACCEPTED, f"{name} returns {row.__name__}, which overlay does not accept"


@pytest.mark.parametrize("row", ACCEPTED, ids=[r.__name__ for r in ACCEPTED])
def test_each_accepted_row_type_carries_what_overlay_keys_on(row: type) -> None:
    assert is_dataclass(row)
    carried = {f.name for f in fields(row)}
    # the identity of a row and the time Notion last edited it decide which edit still shows
    assert {"page_id", "notion_edited_at"} <= carried
    if "done" in carried:  # a milestone: overlay reads `done` to choose its kind
        assert {"done", "due_date"} <= carried
        assert "status" not in carried, "a milestone with a `status` is a card to a reader"
    else:  # a card
        assert "status" in carried
        assert not carried & EDITABLE["milestone"], "a card must not carry a milestone's field"


def test_the_full_rows_carry_every_field_that_can_be_edited() -> None:
    from yawmi.goals.reader import CardFullRow, MilestoneFullRow

    assert EDITABLE["milestone"] <= {f.name for f in fields(MilestoneFullRow)}
    assert EDITABLE["card"] <= {f.name for f in fields(CardFullRow)}


def test_a_row_type_without_done_would_be_misread_as_a_card() -> None:
    """The failure this guards: overlay's kind comes from `hasattr(row, "done")`."""
    from dataclasses import dataclass
    from datetime import date, datetime

    @dataclass(frozen=True)
    class Lost:
        page_id: str
        due_date: date | None
        notion_edited_at: datetime | None

    assert not hasattr(Lost("p", None, None), "done")
    carried = {f.name for f in fields(Lost)}
    assert "done" not in carried and "status" not in carried  # what the test above rejects
