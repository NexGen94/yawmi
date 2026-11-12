"""Models for habit and goal indicators (design §7.5).

`IndicatorIO` is the one schema: the body of `PUT /v1/indicators/{subject_kind}/{subject_ref}`
and what is read back. `id` and `updated_at` are the server's: a body that carries them is not
refused, and they are ignored. The subject of a `PUT` is the URL's; the body repeats it, and a
body that names another subject is a 422.
"""

from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError

from yawmi.habits.models import Ref, ReminderIO, ShortTitle, Target

SubjectKind = Literal["habit", "goal"]


class IndicatorIO(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    subject_kind: SubjectKind
    subject_ref: Ref
    title_ar: ShortTitle | None = None
    source: Literal["habit_logs", "linked_habits", "milestones", "tasks"]
    measure: Literal["completion", "total", "avg_7d", "avg_30d", "strength"]
    target: Target | None = None
    period: Literal["day", "week", "month", "cycle", "all"]
    display: Literal["ring", "bar", "number", "sparkline"]
    reminder: ReminderIO | None = None
    id: UUID | None = Field(default=None, description="للقراءة فقط: يضعه الخادم")
    updated_at: datetime | None = Field(default=None, description="للقراءة فقط: يضعه الخادم")

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
        else:
            if self.source == "habit_logs":
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


class IndicatorList(BaseModel):
    items: list[IndicatorIO]
