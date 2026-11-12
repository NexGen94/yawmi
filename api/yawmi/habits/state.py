"""Habit state determination per Design §9.1.

Six states evaluated in strict order:
1. archived: `active` is False
2. upcoming: `start_day > today`
3. ended: `end_day is not None and end_day < today`
4. done: `period_progress.reached` for current period (does not apply to abstain habits)
5. late:
   - day period (abstain): slip (`done`) recorded today or yesterday
   - day period (build): last scheduled day before today inside `[start_day, today)`
     has no `done`, no `skip`, and no `vacation`
   - week/month period: `on_track` is False
6. active: otherwise
"""

from collections.abc import Sequence
from datetime import date, timedelta
from typing import Literal

from yawmi.domain.habits import HabitLog, HabitSpec, period_progress
from yawmi.domain.periods import WeekStart, is_scheduled

HabitState = Literal["archived", "upcoming", "ended", "done", "late", "active"]


def _last_scheduled_before(spec: HabitSpec, today: date) -> date | None:
    current = today - timedelta(days=1)
    while current >= spec.start_day:
        if is_scheduled(current, spec):
            return current
        current -= timedelta(days=1)
    return None


def habit_state(
    spec: HabitSpec,
    logs: Sequence[HabitLog],
    today: date,
    week_start: WeekStart,
    active: bool = True,
) -> HabitState:
    if not active:
        return "archived"
    if spec.start_day > today:
        return "upcoming"
    if spec.end_day is not None and spec.end_day < today:
        return "ended"

    # Rule 4: done (period reached, does NOT apply to abstain habits)
    if spec.polarity != "abstain":
        progress = period_progress(spec, logs, today, week_start)
        if progress.reached:
            return "done"

    # Rule 5: late
    if spec.period == "day":
        if spec.polarity == "abstain":
            if any(
                lg.status == "done" and lg.day in (today, today - timedelta(days=1)) for lg in logs
            ):
                return "late"
        else:
            last_day = _last_scheduled_before(spec, today)
            if last_day is not None:
                logs_on_day = [lg for lg in logs if lg.day == last_day]
                if not any(lg.status in ("done", "skip", "vacation") for lg in logs_on_day):
                    return "late"
    else:
        progress = period_progress(spec, logs, today, week_start)
        if not progress.on_track:
            return "late"

    return "active"
