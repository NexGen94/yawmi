"""The goal indicator (design §9.3): milestones, linked habits and tasks, and the default source."""

import pytest

from yawmi.indicators.compute import default_source, indicator_value


def value(source: str, **kw: object):
    base: dict[str, object] = {
        "milestones_done": 0,
        "milestones_total": 0,
        "habit_completions": [],
        "tasks_done": 0,
        "tasks_total": 0,
        "target": None,
    }
    return indicator_value(source, **{**base, **kw})  # type: ignore[arg-type]


def test_milestones_three_of_twelve_is_a_quarter() -> None:
    v = value("milestones", milestones_done=3, milestones_total=12)
    assert v.source == "milestones"
    assert (v.value, v.target, v.completion) == (3, 12, 0.25)
    assert v.custom is False


def test_linked_habits_average_their_completion_without_weights() -> None:
    v = value("linked_habits", habit_completions=[0.5, 1.0])
    assert v.completion == pytest.approx(0.75)
    assert (v.value, v.target) == (pytest.approx(75.0), 100.0)  # a percentage


def test_tasks_two_of_five_is_forty_percent() -> None:
    v = value("tasks", tasks_done=2, tasks_total=5)
    assert (v.value, v.target, v.completion) == (2, 5, 0.4)


@pytest.mark.parametrize(
    ("source", "kw"),
    [
        ("tasks", {}),
        ("milestones", {}),
        ("linked_habits", {}),
    ],
)
def test_nothing_to_measure_is_none_not_zero(source: str, kw: dict[str, object]) -> None:
    v = value(source, **kw)
    assert v.value is None and v.completion is None


def test_a_target_replaces_the_total_and_completion_is_capped_at_one() -> None:
    v = value("tasks", tasks_done=2, tasks_total=5, target=4)
    assert (v.value, v.target, v.completion) == (2, 4, 0.5)
    v = value("tasks", tasks_done=5, tasks_total=5, target=4)
    assert v.completion == 1.0


def test_a_target_works_without_any_task_yet_as_zero_progress() -> None:
    v = value("tasks", tasks_done=0, tasks_total=0, target=3)
    assert (v.value, v.target, v.completion) == (0, 3, 0.0)


@pytest.mark.parametrize(
    ("milestones", "habits", "tasks", "expected"),
    [
        (12, 3, 5, "milestones"),
        (0, 3, 5, "linked_habits"),
        (0, 0, 5, "tasks"),
        (0, 0, 0, "tasks"),
    ],
)
def test_the_default_source_is_milestones_then_habits_then_tasks(
    milestones: int, habits: int, tasks: int, expected: str
) -> None:
    assert default_source(milestones, habits, tasks) == expected


def test_an_unknown_source_is_refused() -> None:
    with pytest.raises(ValueError):
        value("habit_logs")
