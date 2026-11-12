"""`GoalsOut` from rows: the pure part of `GET /v1/goals` (design §7.4 and §9.3). No I/O, no clock.

The completion of an outcome counts milestones as Notion does (done ÷ all); habits, tasks and
indicators never change it. The habit lists, the next milestone and the card averages are the
ones `GET /v1/overview` shows, built by the same functions of `yawmi.today.assemble`, so the two
routes cannot disagree.

The indicator of an outcome or a card is the stored one for that goal if the user customised it
(`custom`), else the default of design §9.3: milestones if it has any, else linked habits, else
tasks. A linked habit counts through its completion for the current period, and only while its
window holds today.
"""

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime

from yawmi.domain.habits import HabitLog, HabitSpec, period_progress
from yawmi.domain.periods import WeekStart
from yawmi.goals.models import (
    CardFull,
    CycleOut,
    GoalIndicatorValue,
    GoalOutcome,
    GoalsOut,
    KpiLatest,
    KpiOut,
    MilestoneFull,
)
from yawmi.goals.reader import (
    CardFieldsRow,
    CardFullRow,
    CycleFullRow,
    KpiRow,
    MilestoneFullRow,
    OutcomeRow,
    ReadingRow,
)
from yawmi.goals.tasks_store import TaskCounts
from yawmi.habits.models import domain_logs
from yawmi.indicators.compute import default_source, indicator_value
from yawmi.indicators.models import IndicatorIO
from yawmi.today.assemble import build_cards, build_outcomes, habit_spec
from yawmi.today.reader import CardRow, GoalRow, HabitRow, LogRow, MilestoneRow

NO_TASKS = TaskCounts(0, 0)


def _milestone_key(m: MilestoneFullRow) -> tuple[bool, date, int, str, str]:
    return (m.due_date is None, m.due_date or date.max, m.cycle_no or 0, m.title, m.page_id)


def overdue_days(m: MilestoneFullRow, today: date) -> int | None:
    """Days past the due day of an open milestone; `None` when done, undated or not yet late."""
    if m.done or m.due_date is None or m.due_date >= today:
        return None
    return (today - m.due_date).days


def _milestone_full(m: MilestoneFullRow, today: date) -> MilestoneFull:
    return MilestoneFull(
        page_id=m.page_id,
        title=m.title,
        outcome_code=m.outcome_code,
        card_page_ids=list(m.card_page_ids),
        cycle_no=m.cycle_no,
        due_date=m.due_date,
        done=m.done,
        criterion=m.criterion,
        evidence=m.evidence,
        notion_edited_at=m.notion_edited_at,
        overdue_days=overdue_days(m, today),
        pending=[],
    )


def _completions(
    habits: Iterable[HabitRow], logs: Iterable[LogRow], today: date, week_start: WeekStart
) -> dict[str, float]:
    """The current-period completion of each habit whose window holds `today`, by code."""
    by_habit: dict[str, list[LogRow]] = defaultdict(list)
    for log in logs:
        by_habit[log.habit_code].append(log)
    out: dict[str, float] = {}
    for row in habits:
        spec: HabitSpec = habit_spec(row)
        if spec.start_day > today or (spec.end_day is not None and spec.end_day < today):
            continue
        history: list[HabitLog] = domain_logs(by_habit.get(row.code, []))
        out[row.code] = period_progress(spec, history, today, week_start).completion
    return out


def _indicator(
    ref: str,
    *,
    milestones_done: int,
    milestones_total: int,
    habit_codes: Sequence[str],
    completions: Mapping[str, float],
    tasks: TaskCounts,
    stored: Mapping[str, IndicatorIO],
) -> GoalIndicatorValue:
    habit_completions = [completions[c] for c in habit_codes if c in completions]
    custom = stored.get(ref)
    source = (
        custom.source
        if custom is not None
        else default_source(milestones_total, len(habit_completions), tasks.total)
    )
    value = indicator_value(
        source,
        milestones_done=milestones_done,
        milestones_total=milestones_total,
        habit_completions=habit_completions,
        tasks_done=tasks.done,
        tasks_total=tasks.total,
        target=custom.target if custom is not None else None,
    )
    if custom is None:
        return value
    return value.model_copy(update={"display": custom.display, "custom": True})


def _kpi_out(row: KpiRow, latest: Mapping[str, ReadingRow]) -> KpiOut:
    reading = latest.get(row.code)
    return KpiOut(
        code=row.code,
        name=row.name,
        unit=row.unit,
        direction=row.direction,
        target=None if row.target is None else float(row.target),
        frequency=row.frequency,
        latest=None if reading is None else KpiLatest(day=reading.day, value=float(reading.value)),
    )


def build_goals(
    *,
    outcomes: Sequence[OutcomeRow],
    cycles: Iterable[CycleFullRow],
    milestones: Sequence[MilestoneFullRow],
    cards: Sequence[CardFullRow],
    card_fields: Iterable[CardFieldsRow],
    kpis: Iterable[KpiRow],
    latest: Mapping[str, ReadingRow],
    synced_at: datetime | None,
    habits: Sequence[HabitRow],
    logs: Sequence[LogRow],
    task_counts: Mapping[str, TaskCounts],
    stored: Mapping[str, IndicatorIO],
    today: date,
    week_start: WeekStart,
) -> GoalsOut:
    """The whole read model. `stored` maps a goal reference to the user's indicator for it."""
    old_milestones = [
        MilestoneRow(
            m.page_id, m.title, m.outcome_code, m.cycle_no, m.due_date, m.done, m.card_page_ids
        )
        for m in milestones
    ]
    base_outcomes = build_outcomes(
        [GoalRow(o.code, o.title, o.target_date, o.status, o.track) for o in outcomes],
        old_milestones,
        today,
        habits,
        logs,
        week_start,
    )
    base_cards = build_cards(
        [CardRow(c.page_id, c.title, c.status, c.outcome_codes) for c in cards],
        habits,
        logs,
        today,
        week_start,
        old_milestones,
    )
    completions = _completions(habits, logs, today, week_start)
    rows = {o.code: o for o in outcomes}
    fields = {f.page_id: f for f in card_fields}
    full = {c.page_id: c for c in cards}
    kpis_of: dict[str | None, list[KpiOut]] = defaultdict(list)
    for kpi in sorted(kpis, key=lambda k: k.code):
        kpis_of[kpi.goal_code].append(_kpi_out(kpi, latest))

    out_outcomes: list[GoalOutcome] = []
    for base in base_outcomes:
        row = rows[base.code]
        mine = [m for m in milestones if m.outcome_code == base.code]
        out_outcomes.append(
            GoalOutcome(
                code=base.code,
                title=base.title,
                track=base.track,
                target_date=base.target_date,
                acceptance=row.acceptance,
                status=base.status,
                milestones_total=base.milestones_total,
                milestones_done=base.milestones_done,
                milestones_due=sum(1 for m in mine if m.due_date and m.due_date <= today),
                completion=base.completion,
                next_milestone=base.next_milestone,
                habits=base.habits,
                indicator=_indicator(
                    base.code,
                    milestones_done=base.milestones_done,
                    milestones_total=base.milestones_total,
                    habit_codes=[h.code for h in base.habits],
                    completions=completions,
                    tasks=task_counts.get(base.code, NO_TASKS),
                    stored=stored,
                ),
                kpis=kpis_of.get(base.code, []),
            )
        )

    out_cards: list[CardFull] = []
    for base_card in base_cards:
        card = full[base_card.page_id]
        extra = fields.get(card.page_id)
        mine = [m for m in milestones if card.page_id in m.card_page_ids]
        done = sum(1 for m in mine if m.done)
        tasks = task_counts.get(card.page_id, NO_TASKS)
        out_cards.append(
            CardFull(
                page_id=card.page_id,
                title=card.title,
                status=card.status,
                outcome_codes=list(card.outcome_codes),
                target_date=extra.target_date if extra else None,
                next_step=extra.next_step if extra else None,
                notion_edited_at=card.notion_edited_at,
                habits=base_card.habits,
                habits_adherence_avg=base_card.habits_adherence_avg,
                milestones_total=len(mine),
                milestones_done=done,
                tasks_total=tasks.total,
                tasks_done=tasks.done,
                indicator=_indicator(
                    card.page_id,
                    milestones_done=done,
                    milestones_total=len(mine),
                    habit_codes=[h.code for h in base_card.habits],
                    completions=completions,
                    tasks=tasks,
                    stored=stored,
                ),
                pending=[],
            )
        )

    return GoalsOut(
        outcomes=out_outcomes,
        cycles=[CycleOut(**vars(c)) for c in cycles],
        milestones=[_milestone_full(m, today) for m in sorted(milestones, key=_milestone_key)],
        cards=out_cards,
        synced_at=synced_at,
        pending_edits=0,
    )
