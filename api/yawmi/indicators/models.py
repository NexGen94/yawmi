"""Models for habit and goal indicators."""

from datetime import datetime
from typing import Literal, Self
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, model_validator
from pydantic_core import PydanticCustomError


class IndicatorReminderIO(BaseModel):
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    days_mask: int = Field(ge=1, le=127)


class IndicatorIn(BaseModel):
    subject_kind: Literal["habit", "goal"]
    subject_ref: str
    title_ar: str | None = None
    source: Literal["habit_logs", "linked_habits", "milestones", "tasks"]
    measure: Literal["completion", "total", "avg_7d", "avg_30d", "strength"]
    target: float | None = Field(default=None, gt=0)
    period: Literal["day", "week", "month", "cycle", "all"]
    display: Literal["ring", "bar", "number", "sparkline"]
    reminder: IndicatorReminderIO | None = None

    @model_validator(mode="after")
    def validate_indicator_shape(self) -> Self:
        if self.subject_kind == "habit":
            if self.source != "habit_logs":
                raise PydanticCustomError(
                    "habit_source_invalid",
                    "Habit indicator source must be habit_logs",
                )
            if self.reminder is not None:
                raise PydanticCustomError(
                    "habit_reminder_invalid",
                    "Habit indicator cannot have a custom reminder",
                )
        elif self.subject_kind == "goal":
            if self.source not in ("linked_habits", "milestones", "tasks"):
                raise PydanticCustomError(
                    "goal_source_invalid",
                    "Goal indicator source must be linked_habits, milestones, or tasks",
                )
            if self.measure != "completion":
                raise PydanticCustomError(
                    "goal_measure_invalid",
                    "Goal indicator measure must be completion",
                )
        return self


class IndicatorIO(IndicatorIn):
    id: UUID = Field(default_factory=uuid4)
    updated_at: datetime | None = None


class IndicatorList(BaseModel):
    items: list[IndicatorIO]
