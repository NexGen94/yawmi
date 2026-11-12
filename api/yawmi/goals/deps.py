"""FastAPI dependencies of the goals routes: each reader is the one injected into the app (tests),
else the Postgres one over the lifespan's pool."""

from typing import Annotated

from fastapi import Depends, Request

from yawmi.db.pool import get_pool
from yawmi.goals.reader import AsyncpgGoalsReader, GoalsReader
from yawmi.goals.service import GoalSources
from yawmi.goals.tasks_store import AsyncpgGoalTaskStore, GoalTaskStore
from yawmi.indicators.store import AsyncpgIndicatorStore, IndicatorStore
from yawmi.today.reader import AsyncpgTodayReader, TodayReader


def get_goals_reader(request: Request) -> GoalsReader:
    injected: GoalsReader | None = getattr(request.app.state, "goals", None)
    return injected if injected is not None else AsyncpgGoalsReader(get_pool())


def get_task_store(request: Request) -> GoalTaskStore:
    injected: GoalTaskStore | None = getattr(request.app.state, "goal_tasks", None)
    return injected if injected is not None else AsyncpgGoalTaskStore(get_pool())


def get_goals_today_reader(request: Request) -> TodayReader:
    injected: TodayReader | None = getattr(request.app.state, "today", None)
    return injected if injected is not None else AsyncpgTodayReader(get_pool())


def get_goals_indicators(request: Request) -> IndicatorStore:
    injected: IndicatorStore | None = getattr(request.app.state, "indicators", None)
    return injected if injected is not None else AsyncpgIndicatorStore(get_pool())


GoalsReaderDep = Annotated[GoalsReader, Depends(get_goals_reader)]
TaskStoreDep = Annotated[GoalTaskStore, Depends(get_task_store)]


def get_sources(
    goals: GoalsReaderDep,
    today: Annotated[TodayReader, Depends(get_goals_today_reader)],
    tasks: TaskStoreDep,
    indicators: Annotated[IndicatorStore, Depends(get_goals_indicators)],
) -> GoalSources:
    return GoalSources(goals=goals, today=today, tasks=tasks, indicators=indicators)


SourcesDep = Annotated[GoalSources, Depends(get_sources)]
