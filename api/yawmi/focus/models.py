"""Focus plans and the read models of the focus and breath sessions (design §7.5, §7.6).

`FocusPlanIO` is the body of `POST /v1/focus/plans`; `FocusPlanOut` adds the server's `id` and
`updated_at`. A schedule is a weekday mask and a start time together or not at all (a 422 names
`schedule_incomplete`). A plan is never deleted: `active = false` hides it. The sessions are rows
projected from `focus_ended` and `breath_ended` events; they are read here and never written.
"""

from datetime import date, datetime
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator
from pydantic_core import PydanticCustomError

from yawmi.habits.models import Clock, DayMask, Ref, ShortTitle

Minutes = Annotated[StrictInt, Field(ge=5, le=240, description="من 5 إلى 240 دقيقة")]
_REQUIRED = ("title_ar", "minutes", "favorite", "active")
SCHEDULE_INCOMPLETE = "القناع والوقت معاً أو لا شيء"
NULL_NOT_ALLOWED = "الحقل لا يقبل null"


def schedule_is_complete(weekday_mask: int | None, start_time: str | None) -> bool:
    """A schedule is both of its parts or neither."""
    return (weekday_mask is None) == (start_time is None)


class FocusPlanIO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title_ar: ShortTitle
    minutes: Minutes
    goal_ref: Ref | None = None
    habit_code: Ref | None = None
    favorite: StrictBool = False
    weekday_mask: DayMask | None = None
    start_time: Clock | None = None
    active: StrictBool = True

    @model_validator(mode="after")
    def _schedule_is_whole(self) -> Self:
        if not schedule_is_complete(self.weekday_mask, self.start_time):
            raise PydanticCustomError("schedule_incomplete", SCHEDULE_INCOMPLETE)
        return self


class FocusPlanOut(FocusPlanIO):
    id: UUID
    updated_at: datetime


class FocusPlanPatch(BaseModel):
    """Any of the fields of `FocusPlanIO`; only the sent ones change. `goal_ref`, `habit_code`
    and the two schedule parts may be sent as `null` (the schedule parts together)."""

    model_config = ConfigDict(extra="forbid")

    title_ar: ShortTitle | None = None
    minutes: Minutes | None = None
    goal_ref: Ref | None = None
    habit_code: Ref | None = None
    favorite: StrictBool | None = None
    weekday_mask: DayMask | None = None
    start_time: Clock | None = None
    active: StrictBool | None = None

    @model_validator(mode="after")
    def _required_fields_are_not_null(self) -> Self:
        for name in _REQUIRED:
            if name in self.model_fields_set and getattr(self, name) is None:
                raise PydanticCustomError("null_not_allowed", NULL_NOT_ALLOWED)
        return self

    def changes(self) -> dict[str, Any]:
        return {name: getattr(self, name) for name in self.model_fields_set}


class FocusPlanList(BaseModel):
    items: list[FocusPlanOut]


class FocusSessionOut(BaseModel):
    id: UUID
    day: date
    started_at: datetime
    ended_at: datetime | None
    planned_minutes: int | None
    actual_minutes: float | None
    goal_ref: str | None
    habit_code: str | None
    focus_rating: int | None
    next_step: str | None


class FocusSessionList(BaseModel):
    items: list[FocusSessionOut]


class BreathSessionOut(BaseModel):
    id: UUID
    day: date
    started_at: datetime
    ended_at: datetime | None
    pattern: str
    breaths_per_min: float | None
    duration_seconds: int | None
    completed: bool
    feeling: Literal["calmer", "same", "tense"] | None


class BreathSessionList(BaseModel):
    items: list[BreathSessionOut]
