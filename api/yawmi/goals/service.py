"""The I/O around the pure goals functions: load the sources, build `GoalsOut` and `PaceOut`.

`GoalSources` bundles the four readers the goals need: the Notion mirror, the habits and logs,
the user's tasks and the stored indicators. The route and the push notices both use
`load_goals`, so the goal indicator that a reminder quotes is the one the screen shows.
"""

import math
from dataclasses import dataclass
from datetime import date

from yawmi.domain.habits import CUMULATIVE_KPIS
from yawmi.domain.periods import WeekStart
from yawmi.goals.assemble import build_goals
from yawmi.goals.models import GoalsOut, PaceOut, PaceReading
from yawmi.goals.pace import pace_line
from yawmi.goals.reader import GoalsReader, KpiRow
from yawmi.goals.tasks_store import GoalTaskStore
from yawmi.indicators.store import IndicatorStore
from yawmi.today.reader import TodayReader

# the plan began on 2026-10-31 (D-043): the start of every pace line
PLAN_START = date(2026, 10, 31)


@dataclass(frozen=True)
class GoalSources:
    goals: GoalsReader
    today: TodayReader
    tasks: GoalTaskStore
    indicators: IndicatorStore


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
    )


def _paceable(kpi: KpiRow) -> bool:
    """A cumulative KPI, or an ascending one, with one finite positive target (design §9.4)."""
    if kpi.target is None or not math.isfinite(float(kpi.target)) or float(kpi.target) <= 0:
        return False
    return kpi.code in CUMULATIVE_KPIS or kpi.direction == "up"


async def load_pace(
    goals: GoalsReader, ref: str, kpi_code: str | None, today: date
) -> PaceOut | None:
    """The pace of outcome `ref`, or `None` if the mirror has no such outcome.

    The basis is a KPI of the outcome (`kpi_code` if it names a usable one, else the first usable
    one, cumulative ones first) or, with none, the milestones: done over all, from the plan's start.
    """
    outcome = next((o for o in await goals.outcomes() if o.code == ref), None)
    if outcome is None:
        return None
    usable = sorted(
        (k for k in await goals.kpis() if k.goal_code == ref and _paceable(k)),
        key=lambda k: (k.code not in CUMULATIVE_KPIS, k.code),
    )
    chosen = next((k for k in usable if k.code == kpi_code), usable[0] if usable else None)
    readings: list[PaceReading] = []
    if chosen is not None and chosen.target is not None:
        readings = [
            PaceReading(day=r.day, value=float(r.value))
            for r in await goals.readings(chosen.code)
            if r.day <= today
        ]
        current = readings[-1].value if readings else None
        target = float(chosen.target)
    else:
        mine = [m for m in await goals.milestones() if m.outcome_code == ref]
        current, target = float(sum(1 for m in mine if m.done)), float(len(mine))
    expected, projected, on_pace = pace_line(
        PLAN_START, 0.0, outcome.target_date, target, today, current
    )
    return PaceOut(
        basis="kpi" if chosen is not None else "milestones",
        kpi_code=chosen.code if chosen is not None else None,
        unit=chosen.unit if chosen is not None else None,
        start_day=PLAN_START,
        start_value=0.0,
        due_day=outcome.target_date,
        target_value=target,
        today=today,
        current_value=current,
        expected_today=expected,
        projected_end=projected,
        on_pace=on_pace,
        days_left=(outcome.target_date - today).days,
        readings=readings,
    )
