"""Projection decisions: which row an event becomes. Pure: no I/O, no clock, no SQL.

`project_event` validates an event's payload and returns an *intent*: a plain value saying
which table gets which row (or `None` when the event is only stored in `events`). The store
executes intents; it makes no decisions of its own, so everything that can be wrong about a
projection is testable here without a database.

Payload shapes (unknown extra fields are ignored so that newer clients keep working; the
original payload is stored in `events` untouched):

* `habit_logged`  `{habit_code, status: done|skip|vacation, day?, value?}`
* `habit_skipped` / `habit_vacation`  `{habit_code, day?}`  (the type decides the status)
* `focus_ended`   `{habit_code?, goal_ref?, started_at?, ended_at?, planned_minutes?,
  actual_minutes?, focus_rating?, next_step?}`
* `breath_ended`  `{pattern, started_at?, ended_at?, breaths_per_min?, duration_seconds?,
  completed?}`
* every other type is stored in `events` only and may carry any JSON object.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Literal, get_args

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    Field,
    StrictBool,
    StrictInt,
    StringConstraints,
    ValidationError,
)
from pydantic_core import PydanticCustomError

from yawmi.domain.days import day_key

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from uuid import UUID

    from yawmi.events.models import EventIn

EventType = Literal[
    "habit_logged",
    "habit_skipped",
    "habit_vacation",
    "day_closed",
    "focus_started",
    "focus_ended",
    "breath_ended",
    "mood_logged",
    "confounder_tagged",
    "app_opened",
]
EVENT_TYPES: tuple[str, ...] = get_args(EventType)

# A habit log may be back-dated by at most this many days, counted from the local day of the
# event itself (not from the server clock), so a queue replayed late still lands where it should.
MAX_BACKDATE_DAYS = 7

INVALID_PAYLOAD = "حمولة الحدث غير صالحة"
DAY_OUT_OF_WINDOW = "لا يمكن تعديل يوم يسبق يوم الحدث بأكثر من 7 أيام"
DAY_IN_FUTURE = "لا يمكن تسجيل يوم يلي يوم الحدث"
SESSION_BOUNDS = "نهاية الجلسة تسبق بدايتها"


class ProjectionError(ValueError):
    """The event cannot be projected; `code` is machine-readable, `message` is Arabic."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# --- value types shared by the envelope and the payloads --------------------------------------

EARLIEST = datetime(2000, 1, 1, tzinfo=UTC)
LATEST = datetime(2100, 1, 1, tzinfo=UTC)


def _iso_text_only(value: object) -> object:
    """Numbers are not ISO-8601: pydantic would read them as Unix timestamps."""
    if isinstance(value, bool | int | float):
        raise PydanticCustomError("datetime_not_iso", "الوقت يجب أن يكون نصاً بصيغة ISO 8601")
    return value


def _plausible(value: datetime) -> datetime:
    """Refuse years outside 2000..2099: they overflow UTC conversion or poison ordering."""
    if not EARLIEST <= value < LATEST:
        raise PydanticCustomError("datetime_out_of_range", "الوقت خارج النطاق المعقول")
    return value


Instant = Annotated[AwareDatetime, BeforeValidator(_iso_text_only), AfterValidator(_plausible)]

Code = Annotated[str, StringConstraints(min_length=1, max_length=64)]
Quantity = Annotated[Decimal, Field(ge=0, le=1_000_000, max_digits=12, decimal_places=4)]
Minutes = Annotated[Decimal, Field(ge=0, le=100_000, max_digits=12, decimal_places=4)]
PositiveInt4 = Annotated[StrictInt, Field(gt=0, le=2_147_483_647)]


# --- payload schemas ---------------------------------------------------------------------------


class HabitLoggedPayload(BaseModel):
    habit_code: Code
    day: date | None = None
    value: Quantity | None = None
    # `missed` exists in the table but is written by the server, never sent by a client
    status: Literal["done", "skip", "vacation"]


class HabitMarkPayload(BaseModel):
    habit_code: Code
    day: date | None = None


class FocusEndedPayload(BaseModel):
    habit_code: Code | None = None
    goal_ref: Annotated[str, StringConstraints(max_length=64)] | None = None
    started_at: Instant | None = None
    ended_at: Instant | None = None
    planned_minutes: PositiveInt4 | None = None
    actual_minutes: Minutes | None = None
    focus_rating: Annotated[StrictInt, Field(ge=1, le=5)] | None = None
    next_step: Annotated[str, StringConstraints(max_length=500)] | None = None


class BreathEndedPayload(BaseModel):
    # NOT NULL in the schema, so it cannot fall back to NULL like the other columns
    pattern: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    started_at: Instant | None = None
    ended_at: Instant | None = None
    breaths_per_min: (
        Annotated[Decimal, Field(gt=0, le=1000, max_digits=8, decimal_places=3)] | None
    ) = None
    duration_seconds: Annotated[StrictInt, Field(ge=0, le=10_000_000)] | None = None
    completed: StrictBool = True  # the column default


# --- intents -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class HabitLog:
    """Upsert into `habit_logs` on `(habit_code, day, source)`, last writer (`logged_at`) wins."""

    event_id: "UUID"
    habit_code: str
    day: date
    status: Literal["done", "skip", "vacation"]
    value: Decimal | None
    source: str
    logged_at: datetime


@dataclass(frozen=True)
class FocusSession:
    """Insert into `focus_sessions` (id = the event id)."""

    event_id: "UUID"
    habit_code: str | None
    goal_ref: str | None
    day: date
    started_at: datetime
    ended_at: datetime
    planned_minutes: int | None
    actual_minutes: Decimal | None
    focus_rating: int | None
    next_step: str | None


@dataclass(frozen=True)
class BreathSession:
    """Insert into `breath_sessions` (id = the event id)."""

    event_id: "UUID"
    day: date
    started_at: datetime
    ended_at: datetime
    pattern: str
    breaths_per_min: Decimal | None
    duration_seconds: int | None
    completed: bool


Intent = HabitLog | FocusSession | BreathSession


@dataclass(frozen=True)
class Planned:
    """One event of a batch with its position and its projection (`None`: events table only)."""

    index: int
    event: "EventIn"
    intent: Intent | None


# --- decisions ---------------------------------------------------------------------------------


def _parse[M: BaseModel](model: type[M], payload: dict[str, object]) -> M:
    try:
        return model.model_validate(payload)
    except ValidationError:
        raise ProjectionError("invalid_payload", INVALID_PAYLOAD) from None


def _habit_day(payload_day: date | None, event: "EventIn") -> date:
    """`payload.day` when given (within the back-date window), else the event's local day."""
    event_day = day_key(event.occurred_at, event.tz)
    if payload_day is None:
        return event_day
    if payload_day > event_day:
        raise ProjectionError("day_in_future", DAY_IN_FUTURE)
    if (event_day - payload_day).days > MAX_BACKDATE_DAYS:
        raise ProjectionError("day_out_of_window", DAY_OUT_OF_WINDOW)
    return payload_day


def _bounds(
    event: "EventIn", started_at: datetime | None, ended_at: datetime | None, span: timedelta | None
) -> tuple[datetime, datetime]:
    """Start and end of a session: the payload's, else derived from the event time and length."""
    end = ended_at if ended_at is not None else event.occurred_at
    if started_at is not None:
        start = started_at
    else:
        start = end - span if span is not None else end
    if start > end:
        raise ProjectionError("session_bounds", SESSION_BOUNDS)
    return start, end


def project_event(event: "EventIn", source: str) -> Intent | None:
    """Validate `event.payload` for its type and say which row it becomes, if any.

    `source` is the kind of the device that sent it (`iphone`, `watch` or `web`).
    """
    match event.type:
        case "habit_logged":
            logged = _parse(HabitLoggedPayload, event.payload)
            return HabitLog(
                event_id=event.id,
                habit_code=logged.habit_code,
                day=_habit_day(logged.day, event),
                status=logged.status,
                value=logged.value,
                source=source,
                logged_at=event.occurred_at,
            )
        case "habit_skipped" | "habit_vacation":
            mark = _parse(HabitMarkPayload, event.payload)
            return HabitLog(
                event_id=event.id,
                habit_code=mark.habit_code,
                day=_habit_day(mark.day, event),
                status="skip" if event.type == "habit_skipped" else "vacation",
                value=None,
                source=source,
                logged_at=event.occurred_at,
            )
        case "focus_ended":
            focus = _parse(FocusEndedPayload, event.payload)
            focus_span = (
                timedelta(minutes=float(focus.actual_minutes))
                if focus.actual_minutes is not None
                else None
            )
            start, end = _bounds(event, focus.started_at, focus.ended_at, focus_span)
            return FocusSession(
                event_id=event.id,
                habit_code=focus.habit_code,
                goal_ref=focus.goal_ref,
                day=day_key(start, event.tz),
                started_at=start,
                ended_at=end,
                planned_minutes=focus.planned_minutes,
                actual_minutes=focus.actual_minutes,
                focus_rating=focus.focus_rating,
                next_step=focus.next_step,
            )
        case "breath_ended":
            breath = _parse(BreathEndedPayload, event.payload)
            breath_span = (
                timedelta(seconds=breath.duration_seconds)
                if breath.duration_seconds is not None
                else None
            )
            start, end = _bounds(event, breath.started_at, breath.ended_at, breath_span)
            return BreathSession(
                event_id=event.id,
                day=day_key(start, event.tz),
                started_at=start,
                ended_at=end,
                pattern=breath.pattern,
                breaths_per_min=breath.breaths_per_min,
                duration_seconds=breath.duration_seconds,
                completed=breath.completed,
            )
        case _:
            return None


def plan(events: "Sequence[EventIn]", source: str) -> list[Planned]:
    """Project a whole batch, keeping each event's position (the store reports errors by it)."""
    return [Planned(i, event, project_event(event, source)) for i, event in enumerate(events)]


def habit_codes(planned: "Iterable[Planned]") -> set[str]:
    """Every habit code the intents refer to (they must exist in `habits`)."""
    codes: set[str] = set()
    for item in planned:
        if isinstance(item.intent, HabitLog | FocusSession) and item.intent.habit_code is not None:
            codes.add(item.intent.habit_code)
    return codes
