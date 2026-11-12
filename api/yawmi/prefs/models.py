"""Models for user preferences and settings."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError

from yawmi.text import TEXT_INVALID, is_storable


class DayReminderItemIO(BaseModel):
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    days_mask: int = Field(ge=1, le=127)


class DayRemindersIO(BaseModel):
    morning: DayReminderItemIO | None = None
    evening: DayReminderItemIO | None = None
    weekly: DayReminderItemIO | None = None


class GoalColumnsIO(BaseModel):
    outcomes: list[str] = Field(
        default_factory=lambda: [
            "code",
            "title",
            "completion",
            "next_milestone",
            "target_date",
        ]
    )
    milestones: list[str] = Field(
        default_factory=lambda: [
            "title",
            "outcome_code",
            "due_date",
            "done",
            "cycle_no",
        ]
    )
    cards: list[str] = Field(
        default_factory=lambda: [
            "title",
            "status",
            "outcome_codes",
            "target_date",
            "next_step",
            "milestones_done",
        ]
    )


BreathPattern = Literal["calm", "focus", "sleep", "energize", "unwind", "prepare"]
VALID_BREATH_RATES = frozenset({5.0, 5.5, 6.0, 6.5})


class BreathPrefsIO(BaseModel):
    pattern: BreathPattern
    minutes: int = Field(ge=1, le=10)
    rate: float
    sound: bool

    @field_validator("rate")
    @classmethod
    def validate_rate(cls, v: float) -> float:
        if v not in VALID_BREATH_RATES:
            raise PydanticCustomError(
                "rate_invalid", f"Rate must be one of {sorted(VALID_BREATH_RATES)}"
            )
        return v


class SettingsOut(BaseModel):
    mission: str = Field(default="", max_length=600)
    vision: str = Field(default="", max_length=600)
    digits: Literal["latn", "arab"] = "latn"
    ai_lines: Literal[1, 2] = 2
    ai_tone: Literal["direct", "explained"] = "direct"
    ai_checkin: Literal["morning", "evening"] = "evening"
    day_reminders: DayRemindersIO = Field(default_factory=DayRemindersIO)
    late_notice_enabled: bool = True
    late_notice_time: str = Field(default="20:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    goal_columns: GoalColumnsIO = Field(default_factory=GoalColumnsIO)
    focus_daily_target_min: int | None = Field(default=None, ge=5, le=600)
    breath_weekly_target_min: int | None = Field(default=None, ge=5, le=600)
    breath_prefs: BreathPrefsIO | None = None

    @field_validator("mission", "vision")
    @classmethod
    def validate_storable(cls, v: str) -> str:
        if not is_storable(v):
            raise PydanticCustomError("text_invalid", TEXT_INVALID)
        return v


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mission: str | None = Field(default=None, max_length=600)
    vision: str | None = Field(default=None, max_length=600)
    digits: Literal["latn", "arab"] | None = None
    ai_lines: Literal[1, 2] | None = None
    ai_tone: Literal["direct", "explained"] | None = None
    ai_checkin: Literal["morning", "evening"] | None = None
    day_reminders: DayRemindersIO | None = None
    late_notice_enabled: bool | None = None
    late_notice_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    goal_columns: GoalColumnsIO | None = None
    focus_daily_target_min: int | None = Field(default=None, ge=5, le=600)
    breath_weekly_target_min: int | None = Field(default=None, ge=5, le=600)
    breath_prefs: BreathPrefsIO | None = None

    @field_validator("mission", "vision")
    @classmethod
    def validate_storable(cls, v: str | None) -> str | None:
        if v is not None and not is_storable(v):
            raise PydanticCustomError("text_invalid", TEXT_INVALID)
        return v
