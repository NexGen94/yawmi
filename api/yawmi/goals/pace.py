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
    `projected_end` extends the pace so far to the due day, and is `None` on or before the
    start day or with no current value. `on_pace` is `None` with no current value.
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
    return expected, projected, current_value >= expected - 1e-9
