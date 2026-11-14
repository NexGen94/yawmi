"""The pace line of a numeric goal (design §9.4). No I/O: nothing is written anywhere."""

from datetime import date


def pace_line(
    start_day: date,
    start_value: float,
    due_day: date,
    target_value: float,
    today: date,
    current_value: float | None,
) -> tuple[float, float | None, bool | None]:
    """`(expected_today, projected_end, on_pace)`.

    `expected_today` climbs linearly from the start value to the target between the start and
    due days, clamped to the ends; a due day not after the start day expects the target at once.
    `projected_end` extends the pace so far to the due day, capped at the target when the target
    is above the start value (a pace of 1 in 14 days of a 5-year line would otherwise "project"
    145 against a target of 2), and is `None` on or before the start day or with no current
    value. `on_pace` is `None` with no current value.
    """
    span = (due_day - start_day).days
    elapsed = (today - start_day).days
    fraction = 1.0 if span <= 0 else min(1.0, max(0.0, elapsed / span))
    expected = start_value + (target_value - start_value) * fraction
    if current_value is None:
        return expected, None, None
    projected = (
        start_value + (current_value - start_value) * span / elapsed if elapsed > 0 else None
    )
    if projected is not None and target_value >= start_value:
        projected = min(projected, target_value)
    return expected, projected, current_value >= expected - 1e-9


def milestone_pace(due: int, done: int | None) -> tuple[float, float | None, bool | None]:
    """`(expected_today, projected_end, on_pace)` of an outcome paced on its milestones (§9.4).

    The expectation is a count, not a line: the milestones whose due day is on or before today
    (`due`). The outcome is on pace when it has done at least that many, so one whose first
    milestone is in 2027 is on pace until then. A count of dated milestones has no linear
    projection (`None`). `on_pace` is `None` with nothing to measure (`done` is `None`).
    """
    return float(due), None, None if done is None else done >= due
