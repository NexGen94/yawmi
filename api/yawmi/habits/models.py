"""The habit API shapes, their cross-field rules, and the conversions to and from table rows.

API form versus row form: the API always sends `unit` as `''` when a habit has none and `anchor`
as `'free'` when none was chosen; the table stores `NULL` for an empty unit (its CHECK allows only
`session`, `min`, `hour`) and keeps whatever anchor it has (a seeded habit may hold `NULL`, shown
as `'free'`). Reminders are `{time: "HH:mm", days_mask}` in the API and `(at_time, weekday_mask)`
rows in `yawmi.habit_reminders`.

Field-level checks (types, closed sets, ranges, text that Postgres can store) are Pydantic's.
The rules that span fields are `habit_errors`, run by the routes on the habit as it would be
stored (the body for a create, the stored habit merged with the patch for an edit), so a 422
names the field at fault. They mirror the web form (task 17):

* `boolean`: an integer target; `day` = 1, `week` ≤ 7, `month` ≤ 28. `count` and `duration`: any
  finite number > 0.
* `unit`: `''` for `boolean`, `''` or `session` for `count`, `min` or `hour` for `duration`.
* `schedule_kind` other than `every_day` for the `day` period only; `weekdays` needs a mask and
  `every_n_days` needs `every_n` (≥ 2) and `anchor_day`.
* `end_day ≥ start_day`; at most 3 reminders.

Fields that belong to another schedule (a mask on `every_day`, say) are dropped, not refused, so
changing `schedule_kind` alone in a patch is enough.
"""

from datetime import date, time
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StrictInt
from pydantic_core import PydanticCustomError

from yawmi.domain.habits import HabitKind, HabitLog, ScheduleKind
from yawmi.domain.periods import Period
from yawmi.habits.store import Reminder, StoredHabit
from yawmi.text import StorableText
from yawmi.today.reader import LogRow

MAX_REMINDERS = 3
SYSTEM_EDITABLE = frozenset({"anchor", "reminders"})
BOOLEAN_MAX_TARGET: dict[str, int] = {"day": 1, "week": 7, "month": 28}

HabitUnit = Literal["", "session", "min", "hour"]
Anchor = Literal["after_wake", "before_sleep", "free"]
CreatedBy = Literal["seed", "user"]

_TITLE_BLANK = "العنوان مطلوب"


def _title(text: str) -> str:
    text = text.strip()
    if not text:
        raise PydanticCustomError("title_blank", _TITLE_BLANK)
    return text


Title = Annotated[StorableText, Field(max_length=200), AfterValidator(_title)]
Ref = Annotated[StorableText, Field(min_length=1, max_length=128)]
OutcomeCode = Annotated[str, Field(pattern=r"^O([1-9]|1[0-2])$")]
Target = Annotated[float, Field(gt=0, le=100_000)]
DayMask = Annotated[StrictInt, Field(ge=1, le=127, description="بتّ 0 = الأحد … 6 = السبت")]
EveryN = Annotated[StrictInt, Field(ge=2, le=365)]
Clock = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$", description="HH:mm محلياً")]


class ReminderIO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    time: Clock
    days_mask: DayMask


Reminders = Annotated[list[ReminderIO], Field(max_length=MAX_REMINDERS)]


class HabitIn(BaseModel):
    """A new user habit. The server picks `code` (`u_` + 12 hex), `system` and `created_by`.

    Rules across fields (a 422 names the field): a yes/no (`boolean`) target is an integer, 1 for
    `day`, at most 7 for `week` and 28 for `month`; `unit` is `''` for `boolean`, `''` or
    `session` for `count`, `min` or `hour` for `duration`; a `schedule_kind` other than
    `every_day` is for the `day` period only, `weekdays` needs `weekday_mask` and `every_n_days`
    needs `every_n` and `anchor_day`; `end_day` is not before `start_day`.
    """

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    title_ar: Title
    goal_ref: Ref | None = Field(default=None, description="معرّف محطة أو بطاقة في Notion")
    outcome: OutcomeCode | None = None
    ac_ref: Ref | None = None
    kind: HabitKind
    unit: HabitUnit = ""
    target_per_period: Target
    period: Period
    schedule_kind: ScheduleKind = "every_day"
    weekday_mask: DayMask | None = None
    every_n: EveryN | None = None
    anchor_day: date | None = None
    anchor: Anchor = "free"
    start_day: date | None = Field(default=None, description="الافتراضي اليوم بتوقيت الرياض")
    end_day: date | None = None
    reminders: Reminders = Field(default_factory=list)


class HabitPatch(BaseModel):
    """A partial edit: only the fields sent change; `null` clears a nullable field."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    title_ar: Title | None = None
    goal_ref: Ref | None = None
    outcome: OutcomeCode | None = None
    ac_ref: Ref | None = None
    kind: HabitKind | None = None
    unit: HabitUnit | None = None
    target_per_period: Target | None = None
    period: Period | None = None
    schedule_kind: ScheduleKind | None = None
    weekday_mask: DayMask | None = None
    every_n: EveryN | None = None
    anchor_day: date | None = None
    anchor: Anchor | None = None
    start_day: date | None = None
    end_day: date | None = None
    reminders: Reminders | None = None
    active: StrictBool | None = Field(default=None, description="false للأرشفة (لا حذف)")


# fields of `HabitPatch` that must not be sent as null
NOT_NULL = frozenset(
    {
        "title_ar",
        "kind",
        "unit",
        "target_per_period",
        "period",
        "schedule_kind",
        "anchor",
        "start_day",
        "reminders",
        "active",
    }
)


class HabitOut(BaseModel):
    code: str
    title_ar: str
    goal_ref: str | None
    outcome: str | None
    ac_ref: str | None
    kind: HabitKind
    unit: HabitUnit
    target_per_period: float
    period: Period
    schedule_kind: ScheduleKind
    weekday_mask: int | None
    every_n: int | None
    anchor_day: date | None
    anchor: Anchor
    start_day: date
    end_day: date | None
    system: bool
    created_by: CreatedBy
    active: bool
    reminders: list[ReminderIO]


class HabitDraft(BaseModel):
    """An unsaved habit suggested from a goal; the editor opens it and `POST /v1/habits` saves it."""

    title_ar: str
    goal_ref: str
    outcome: str | None
    ac_ref: str | None
    kind: HabitKind
    unit: HabitUnit
    target_per_period: float
    period: Period
    schedule_kind: ScheduleKind
    weekday_mask: int | None
    every_n: int | None
    anchor_day: date | None
    anchor: Anchor
    start_day: date
    end_day: date | None
    reminders: list[ReminderIO]


# --- conversions -------------------------------------------------------------------------------


def _clock(at: time) -> str:
    return at.strftime("%H:%M")


def to_api(habit: StoredHabit) -> dict[str, Any]:
    """The stored habit in API form (the dict behind `HabitOut`)."""
    return {
        "code": habit.code,
        "title_ar": habit.title_ar,
        "goal_ref": habit.goal_ref,
        "outcome": habit.outcome,
        "ac_ref": habit.ac_ref,
        "kind": habit.kind,
        "unit": habit.unit or "",
        "target_per_period": float(habit.target_per_period),
        "period": habit.period,
        "schedule_kind": habit.schedule_kind,
        "weekday_mask": habit.weekday_mask,
        "every_n": habit.every_n,
        "anchor_day": habit.anchor_day,
        "anchor": habit.anchor or "free",
        "start_day": habit.start_day,
        "end_day": habit.end_day,
        "system": habit.system,
        "created_by": habit.created_by,
        "active": habit.active,
        "reminders": [
            {"time": _clock(r.at_time), "days_mask": r.weekday_mask} for r in habit.reminders
        ],
    }


def habit_out(habit: StoredHabit) -> HabitOut:
    return HabitOut.model_validate(to_api(habit))


def normalize(values: dict[str, Any]) -> dict[str, Any]:
    """Drop the fields that belong to another schedule, so they are never stored."""
    out = dict(values)
    if out["schedule_kind"] != "weekdays":
        out["weekday_mask"] = None
    if out["schedule_kind"] != "every_n_days":
        out["every_n"] = None
        out["anchor_day"] = None
    return out


def from_api(values: dict[str, Any]) -> StoredHabit:
    """A habit in API form (every field present) as the row to store."""
    return StoredHabit(
        code=values["code"],
        title_ar=values["title_ar"],
        goal_ref=values["goal_ref"],
        outcome=values["outcome"],
        ac_ref=values["ac_ref"],
        kind=values["kind"],
        unit=values["unit"] or None,
        target_per_period=Decimal(repr(float(values["target_per_period"]))),
        period=values["period"],
        schedule_kind=values["schedule_kind"],
        weekday_mask=values["weekday_mask"],
        every_n=values["every_n"],
        anchor_day=values["anchor_day"],
        anchor=values["anchor"],
        start_day=values["start_day"],
        end_day=values["end_day"],
        system=values["system"],
        created_by=values["created_by"],
        active=values["active"],
        reminders=tuple(
            Reminder(time.fromisoformat(r["time"]), r["days_mask"]) for r in values["reminders"]
        ),
    )


# --- cross-field rules -------------------------------------------------------------------------


def _error(field: str, kind: str, message: str) -> dict[str, Any]:
    return {"loc": ("body", field), "type": kind, "msg": message}


def habit_errors(values: dict[str, Any]) -> list[dict[str, Any]]:
    """The cross-field rules of the module docstring, as 422 error items (`loc`, `type`, `msg`)."""
    errors: list[dict[str, Any]] = []
    kind, unit, period = values["kind"], values["unit"], values["period"]
    target = float(values["target_per_period"])

    if kind == "boolean":
        if target != int(target):
            errors.append(
                _error("target_per_period", "target_not_integer", "هدف عادة نعم أو لا عدد صحيح")
            )
        elif period == "day" and target != 1:
            errors.append(
                _error(
                    "target_per_period", "target_boolean_day", "العادة اليومية بنعم أو لا هدفها 1"
                )
            )
        elif target > BOOLEAN_MAX_TARGET[period]:
            errors.append(
                _error(
                    "target_per_period",
                    "target_over_period",
                    "هدف عادة نعم أو لا لا يتجاوز عدد أيام الفترة",
                )
            )

    allowed_units = {"boolean": {""}, "count": {"", "session"}, "duration": {"min", "hour"}}
    if unit not in allowed_units[kind]:
        errors.append(_error("unit", "unit_kind_mismatch", "الوحدة لا تناسب نوع العادة"))

    schedule = values["schedule_kind"]
    if period != "day" and schedule != "every_day":
        errors.append(
            _error(
                "schedule_kind",
                "schedule_needs_day_period",
                "الجدول الخاص يقتصر على الفترة اليومية",
            )
        )
    elif schedule == "weekdays" and values["weekday_mask"] is None:
        errors.append(
            _error(
                "weekday_mask", "weekday_mask_required", "الأيام المحددة تحتاج يوماً واحداً على الأقل"
            )
        )
    elif schedule == "every_n_days":
        if values["every_n"] is None:
            errors.append(
                _error("every_n", "every_n_required", "التكرار «كل N أيام» يحتاج N من 2 فأكثر")
            )
        if values["anchor_day"] is None:
            errors.append(
                _error("anchor_day", "anchor_day_required", "التكرار «كل N أيام» يحتاج يوم مرساة")
            )

    end = values["end_day"]
    if end is not None and end < values["start_day"]:
        errors.append(_error("end_day", "end_before_start", "يوم النهاية يسبق يوم البداية"))
    return errors


def locked_changes(stored: dict[str, Any], merged: dict[str, Any]) -> set[str]:
    """Fields a system habit cannot change that differ between its stored and edited forms."""
    return {key for key in merged if key not in SYSTEM_EDITABLE and merged[key] != stored[key]}


# --- logs --------------------------------------------------------------------------------------

_STATUSES: frozenset[str] = frozenset({"done", "skip", "vacation", "missed"})


def domain_logs(rows: list[LogRow]) -> list[HabitLog]:
    """Rows as domain logs. A row without a known status (never written by the API) is left out."""
    return [
        HabitLog(
            day=row.day,
            value=None if row.value is None else float(row.value),
            status=row.status,  # type: ignore[arg-type]
        )
        for row in rows
        if row.status in _STATUSES
    ]
