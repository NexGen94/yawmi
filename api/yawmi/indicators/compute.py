"""The indicator of a goal (design §9.3): the numbers behind «2 من 5» and the ring.

Pure: the caller counts milestones, tasks and the current completion of the linked habits.
Nothing to measure (no milestones, no linked habit, no task) gives `value` and `completion`
`None`, never 0 and never NaN: the display says why.
"""

from collections.abc import Sequence

from yawmi.goals.models import GoalIndicatorValue, IndicatorSource


def default_source(milestones_total: int, habits: int, tasks_total: int) -> IndicatorSource:
    """Milestones if the goal has any, else linked habits, else tasks."""
    if milestones_total > 0:
        return "milestones"
    if habits > 0:
        return "linked_habits"
    return "tasks"


def _empty(source: IndicatorSource) -> GoalIndicatorValue:
    return GoalIndicatorValue(source=source, value=None, target=None, completion=None)


def _counted(
    source: IndicatorSource, done: int, total: int, target: float | None
) -> GoalIndicatorValue:
    """`done` of `total`, or of the stored `target` (which replaces the total), capped at 1."""
    goal = float(target) if target is not None else float(total)
    if goal <= 0:
        return _empty(source)
    return GoalIndicatorValue(
        source=source, value=float(done), target=goal, completion=min(1.0, done / goal)
    )


def indicator_value(
    source: str,
    *,
    milestones_done: int,
    milestones_total: int,
    habit_completions: Sequence[float],
    tasks_done: int,
    tasks_total: int,
    target: float | None,
) -> GoalIndicatorValue:
    if source == "milestones":
        return _counted("milestones", milestones_done, milestones_total, target)
    if source == "tasks":
        return _counted("tasks", tasks_done, tasks_total, target)
    if source == "linked_habits":
        if not habit_completions:
            return _empty("linked_habits")
        average = sum(habit_completions) / len(habit_completions)
        return GoalIndicatorValue(
            source="linked_habits", value=average * 100, target=100.0, completion=average
        )
    raise ValueError(f"unknown goal indicator source: {source}")
