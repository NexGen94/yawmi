"""The I/O around the pure goals functions: load the sources, build `GoalsOut` and `PaceOut`.

`GoalSources` bundles the readers the goals need: the Notion mirror, the habits and logs, the
user's tasks, the stored indicators and the goal edits laid over the mirror. The route and the push notices both use
`load_goals`, so the goal indicator that a reminder quotes is the one the screen shows.
"""

import math
from dataclasses import dataclass
from datetime import date

from yawmi.domain.habits import kpi_prefill_kind
from yawmi.domain.periods import WeekStart
from yawmi.goals.assemble import build_goals
from yawmi.goals.edits_store import EditStore
from yawmi.goals.models import GoalsOut, PaceOut, PaceReading
from yawmi.goals.pace import pace_line
from yawmi.goals.reader import GoalsReader, KpiRow
from yawmi.goals.tasks_store import GoalTaskStore
from yawmi.indicators.store import IndicatorStore
from yawmi.today.reader import TodayReader

# the plan began on 2026-10-31 (D-043): the start of every pace line
PLAN_START = date(2026, 10, 31)
# 12 a year (design §13.1, ruling 24): its line is the calendar year's, not the plan's
YEARLY_KPI = "books_done"


@dataclass(frozen=True)
class GoalSources:
    goals: GoalsReader
    today: TodayReader
    tasks: GoalTaskStore
    indicators: IndicatorStore
    edits: EditStore | None = None


async def load_goals(sources: GoalSources, today: date, week_start: WeekStart) -> GoalsOut:
    habits = await sources.today.linked_habits()
    first = min((h.start_day for h in habits), default=today)
    logs = (
        await sources.today.habit_logs_of([h.code for h in habits], first, today) if habits else []
    )
    stored = {
        item.subject_ref: item
        for item in await sources.indicators.list()
        if item.subject_kind == "goal"
    }
    goals = sources.goals
    return build_goals(
        outcomes=await goals.outcomes(),
        cycles=await goals.cycles(),
        milestones=await goals.milestones(),
        cards=await goals.cards(),
        card_fields=await goals.card_fields(),
        kpis=await goals.kpis(),
        latest=await goals.latest_readings(),
        synced_at=await goals.last_synced(),
        habits=habits,
        logs=logs,
        task_counts=await sources.tasks.counts(),
        stored=stored,
        today=today,
        week_start=week_start,
        edits=await sources.edits.current() if sources.edits is not None else (),
    )


def _paceable(kpi: KpiRow) -> bool:
    """A cumulative KPI (a total reached by a date) with one finite positive target (§9.4).

    Weekly counts, averages, levels and percentages are never a pace basis: their target is
    per period, not a total to reach at the due day.
    """
    if kpi.target is None or not math.isfinite(float(kpi.target)) or float(kpi.target) <= 0:
        return False
    return kpi_prefill_kind(
        kpi.code, kpi.direction, kpi.unit, float(kpi.target), kpi.frequency
    ) == ("cumulative")


def _line_span(kpi: KpiRow, due_day: date, today: date) -> tuple[date, date]:
    """The days the pace line runs between. `books_done` is a yearly total (12 a year): its line
    is the current calendar year's, from 1 January (the plan start in 2026) to 31 December."""
    if kpi.code != YEARLY_KPI:
        return PLAN_START, due_day
    return max(PLAN_START, date(today.year, 1, 1)), date(today.year, 12, 31)


async def load_pace(
    goals: GoalsReader, ref: str, kpi_code: str | None, today: date
) -> PaceOut | None:
    """The pace of outcome `ref`, or `None` if the mirror has no such outcome.

    The basis is a cumulative KPI of the outcome (`kpi_code` if it names one, else the first by
    code) or, with none, the milestones: done over all, from the plan's start. With nothing to
    measure (no usable KPI and no milestone) the current value, the projection and `on_pace` are
    `None`: an empty mirror is never reported as on pace.
    """
    outcome = next((o for o in await goals.outcomes() if o.code == ref), None)
    if outcome is None:
        return None
    usable = sorted(
        (k for k in await goals.kpis() if k.goal_code == ref and _paceable(k)),
        key=lambda k: k.code,
    )
    chosen = next((k for k in usable if k.code == kpi_code), usable[0] if usable else None)
    start_day, due_day = PLAN_START, outcome.target_date
    readings: list[PaceReading] = []
    unit: str | None = None
    current: float | None
    if chosen is not None and chosen.target is not None:
        start_day, due_day = _line_span(chosen, due_day, today)
        readings = [
            PaceReading(day=r.day, value=float(r.value))
            for r in await goals.readings(chosen.code, start_day, today)
        ]
        current = readings[-1].value if readings else None
        target, unit = float(chosen.target), chosen.unit
    else:
        mine = [m for m in await goals.milestones() if m.outcome_code == ref]
        current = float(sum(1 for m in mine if m.done)) if mine else None
        target = float(len(mine))
    expected, projected, on_pace = pace_line(start_day, 0.0, due_day, target, today, current)
    return PaceOut(
        basis="kpi" if chosen is not None else "milestones",
        kpi_code=chosen.code if chosen is not None else None,
        unit=unit,
        start_day=start_day,
        start_value=0.0,
        due_day=due_day,
        target_value=target,
        today=today,
        current_value=current,
        expected_today=expected,
        projected_end=projected,
        on_pace=on_pace,
        days_left=(due_day - today).days,
        readings=readings,
    )
