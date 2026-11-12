"""Models for user preferences and settings (design §7.3).

`SettingsOut` is what is read; `SettingsPatch` carries the same keys, all optional. A key that
cannot be empty is typed without `null` in the patch (its `None` default only marks it as not
sent), so `null` sent for it is a 422 and nothing is stored. `null` is legal only where the
design says so: the slots of `day_reminders`, `focus_daily_target_min`,
`breath_weekly_target_min` and `breath_prefs`.

A nested object (`day_reminders`, `goal_columns`, `breath_prefs`) in a patch replaces the stored
one whole: slots and lists it leaves out go back to their defaults.

Reading never trusts the stored rows: `settings_from_stored` falls back to the default for a key
whose stored value does not validate (a row from an older version, or edited by hand), so a bad
row can never make `GET`, `PATCH` or the reminder scheduler fail.
"""

import logging
from collections.abc import Mapping
from typing import Annotated, Any, Literal, get_args

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    ValidationError,
    field_validator,
)
from pydantic_core import PydanticCustomError

from yawmi.habits.models import Clock, ReminderIO
from yawmi.text import StorableText

log = logging.getLogger("yawmi.prefs")


def _not_bool(value: object) -> object:
    """`true` is not a number of lines: a bool is refused before the literal matches `1`."""
    if isinstance(value, bool):
        raise PydanticCustomError("bool_not_int", "قيمة منطقية حيث يلزم عدد")
    return value


class DayRemindersIO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    morning: ReminderIO | None = None
    evening: ReminderIO | None = None
    weekly: ReminderIO | None = None


# The columns a goals table can show (design §7.4): every field of the row model. These are the
# closed sets `goal_columns` draws from.
OutcomeColumn = Literal[
    "code",
    "title",
    "track",
    "target_date",
    "acceptance",
    "status",
    "milestones_total",
    "milestones_done",
    "milestones_due",
    "completion",
    "next_milestone",
    "habits",
    "indicator",
    "kpis",
]
MilestoneColumn = Literal[
    "page_id",
    "title",
    "outcome_code",
    "card_page_ids",
    "cycle_no",
    "due_date",
    "done",
    "criterion",
    "evidence",
    "notion_edited_at",
    "overdue_days",
    "pending",
]
CardColumn = Literal[
    "page_id",
    "title",
    "status",
    "outcome_codes",
    "target_date",
    "next_step",
    "notion_edited_at",
    "habits",
    "habits_adherence_avg",
    "milestones_total",
    "milestones_done",
    "tasks_total",
    "tasks_done",
    "indicator",
    "pending",
]
OutcomeColumns = Annotated[list[OutcomeColumn], Field(max_length=len(get_args(OutcomeColumn)))]
MilestoneColumns = Annotated[
    list[MilestoneColumn], Field(max_length=len(get_args(MilestoneColumn)))
]
CardColumns = Annotated[list[CardColumn], Field(max_length=len(get_args(CardColumn)))]


class GoalColumnsIO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcomes: OutcomeColumns = Field(
        default_factory=lambda: ["code", "title", "completion", "next_milestone", "target_date"]
    )
    milestones: MilestoneColumns = Field(
        default_factory=lambda: ["title", "outcome_code", "due_date", "done", "cycle_no"]
    )
    cards: CardColumns = Field(
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
    model_config = ConfigDict(extra="forbid")

    pattern: BreathPattern
    minutes: Annotated[StrictInt, Field(ge=1, le=10)]
    rate: float
    sound: StrictBool

    @field_validator("rate")
    @classmethod
    def validate_rate(cls, v: float) -> float:
        if v not in VALID_BREATH_RATES:
            raise PydanticCustomError(
                "rate_invalid", f"Rate must be one of {sorted(VALID_BREATH_RATES)}"
            )
        return v


Mission = Annotated[StorableText, Field(max_length=600)]
Digits = Literal["latn", "arab"]
AiLines = Annotated[Literal[1, 2], BeforeValidator(_not_bool)]
AiTone = Literal["direct", "explained"]
AiCheckin = Literal["morning", "evening"]
TargetMinutes = Annotated[StrictInt, Field(ge=5, le=600)]


class SettingsOut(BaseModel):
    mission: Mission = ""
    vision: Mission = ""
    digits: Digits = "latn"
    ai_lines: AiLines = 2
    ai_tone: AiTone = "direct"
    ai_checkin: AiCheckin = "evening"
    day_reminders: DayRemindersIO = Field(default_factory=DayRemindersIO)
    late_notice_enabled: StrictBool = True
    late_notice_time: Clock = "20:00"
    goal_columns: GoalColumnsIO = Field(default_factory=GoalColumnsIO)
    focus_daily_target_min: TargetMinutes | None = None
    breath_weekly_target_min: TargetMinutes | None = None
    breath_prefs: BreathPrefsIO | None = None


class SettingsPatch(BaseModel):
    """The keys to change; the others stay. A nested object replaces the stored one whole."""

    model_config = ConfigDict(extra="forbid")

    mission: Mission = None  # type: ignore[assignment]
    vision: Mission = None  # type: ignore[assignment]
    digits: Digits = None  # type: ignore[assignment]
    ai_lines: AiLines = None  # type: ignore[assignment]
    ai_tone: AiTone = None  # type: ignore[assignment]
    ai_checkin: AiCheckin = None  # type: ignore[assignment]
    day_reminders: DayRemindersIO = None  # type: ignore[assignment]
    late_notice_enabled: StrictBool = None  # type: ignore[assignment]
    late_notice_time: Clock = None  # type: ignore[assignment]
    goal_columns: GoalColumnsIO = None  # type: ignore[assignment]
    focus_daily_target_min: TargetMinutes | None = None
    breath_weekly_target_min: TargetMinutes | None = None
    breath_prefs: BreathPrefsIO | None = None


def validated_changes(changes: Mapping[str, Any]) -> dict[str, Any]:
    """The JSON values to store for `changes`, after the patch rules; a `ValidationError` if bad."""
    patch = SettingsPatch.model_validate(dict(changes))
    return patch.model_dump(exclude_unset=True, mode="json")


def settings_from_stored(stored: Mapping[str, Any]) -> SettingsOut:
    """The settings for the stored `key -> value` rows, the default for any bad or unknown key."""
    good: dict[str, Any] = {}
    for key, value in stored.items():
        if key not in SettingsOut.model_fields:
            continue
        try:
            SettingsOut.model_validate({key: value})
        except ValidationError:
            log.warning("stored setting %s is invalid; its default is used", key)
            continue
        good[key] = value
    return SettingsOut.model_validate(good)
