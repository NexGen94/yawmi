"""Contract tests for `habit_state` across the view cases in `contracts/view-cases/habit_state.json`."""

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from yawmi.domain.habits import HabitLog, HabitSpec
from yawmi.habits.state import habit_state

CASES_FILE = Path(__file__).resolve().parents[2] / "contracts" / "view-cases" / "habit_state.json"


def load_cases() -> list[dict[str, Any]]:
    assert CASES_FILE.is_file(), f"missing cases file: {CASES_FILE}"
    data = json.loads(CASES_FILE.read_text(encoding="utf-8"))
    cases = data.get("cases", [])
    assert len(cases) == 9, f"expected exactly 9 cases, got {len(cases)}"
    return cases


CASES = load_cases()


def test_cases_file_has_exactly_nine_cases() -> None:
    assert len(CASES) == 9


@pytest.mark.parametrize("case", CASES, ids=lambda c: str(c["id"]))
def test_habit_state_matches_contract(case: dict[str, Any]) -> None:
    h = case["habit"]
    spec = HabitSpec(
        kind=h["kind"],
        unit=h["unit"],
        target_per_period=float(h["target_per_period"]),
        period=h["period"],
        schedule_kind=h["schedule_kind"],
        weekday_mask=h["weekday_mask"],
        every_n=h["every_n"],
        anchor_day=date.fromisoformat(h["anchor_day"]) if h["anchor_day"] else None,
        start_day=date.fromisoformat(h["start_day"]),
        end_day=date.fromisoformat(h["end_day"]) if h["end_day"] else None,
        polarity=h.get("polarity", "build"),
    )
    logs = [
        HabitLog(
            day=date.fromisoformat(lg["day"]),
            value=float(lg["value"]) if lg.get("value") is not None else None,
            status=lg["status"],
        )
        for lg in case["logs"]
    ]
    today = date.fromisoformat(case["today"])
    week_start = case["week_start"]
    active = h.get("active", True)

    assert habit_state(spec, logs, today, week_start, active=active) == case["expect"]
