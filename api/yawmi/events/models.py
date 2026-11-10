"""Wire models for `/v1/events`: the event envelope, the batch, and the pull page."""

import json
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

from yawmi.domain.days import DEFAULT_TZ, is_valid_tz
from yawmi.events.project import (
    EARLIEST,
    LATEST,
    EventType,
    Instant,
    ProjectionError,
    project_event,
)

MAX_BATCH = 500
MAX_PAYLOAD_BYTES = 16 * 1024
# an event may be dated at most this far ahead of the server clock (device clocks drift)
MAX_FUTURE = timedelta(hours=24)

_BAD_TEXT = "نص الحمولة غير صالح"
_NOT_FINITE = "الحمولة تحوي رقماً غير منتهٍ"
_FUTURE = "وقت الحدث يسبق الوقت الحالي بأكثر من 24 ساعة"


class PayloadNotJson(ValueError):
    """The payload holds a number JSON cannot represent (NaN or an infinity)."""


def dump_payload(payload: dict[str, Any]) -> str:
    """The text stored in `jsonb`, refusing NaN and the infinities.

    Python's JSON parser accepts the bare tokens `NaN`, `Infinity` and `-Infinity`, and reads
    `1e999` as an infinity; `json.dumps` would write them back out as tokens that `jsonb`
    rejects. Both validation and the store serialise through here, so neither can disagree.
    """
    try:
        return json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except ValueError:
        raise PayloadNotJson("payload holds NaN or an infinity") from None


def _check_storable(payload: dict[str, Any]) -> None:
    """Refuse what Postgres cannot store: NUL characters, lone surrogates, NaN/Infinity, size.

    All of them would otherwise surface as a driver error (a 500) at insert time. The walk is
    iterative so a deeply nested payload cannot exhaust the interpreter stack.
    """
    stack: list[object] = [payload]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            for key, value in item.items():
                stack.append(key)
                stack.append(value)
        elif isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, str):
            try:
                item.encode("utf-8")
            except UnicodeEncodeError:
                raise PydanticCustomError("payload_text_invalid", _BAD_TEXT) from None
            if "\x00" in item:
                raise PydanticCustomError("payload_text_invalid", _BAD_TEXT)
    try:
        text = dump_payload(payload)
    except PayloadNotJson:
        raise PydanticCustomError("payload_not_finite", _NOT_FINITE) from None
    if len(text.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise PydanticCustomError("payload_too_large", "حمولة الحدث أكبر من الحد المسموح")


def server_now() -> datetime:
    """The server clock, as a function so tests can pin it (the 24 h future limit)."""
    return datetime.now(UTC)


def clamp_instant(value: datetime) -> datetime:
    """`value` limited to 2000..2099, the range every stored instant lies in."""
    return min(max(value, EARLIEST), LATEST)


class EventIn(BaseModel):
    """One event as a client queues it.

    `device_id` is never read from the body (the token's `sub` is used) and unknown fields are
    ignored.
    """

    id: UUID  # UUIDv7 minted by the client: the idempotency key
    type: EventType
    payload: dict[str, Any]
    occurred_at: Instant  # timezone-aware ISO-8601 text
    tz: str = DEFAULT_TZ  # IANA zone naming the local day of the event

    @field_validator("occurred_at")
    @classmethod
    def _not_far_in_the_future(cls, value: datetime) -> datetime:
        """At most 24 h ahead of the server: a far-future time would win last-writer-wins for
        its habit and day, and would sort after every real edit. The past is never limited (a
        queue replayed after weeks offline is old). The 7-day back-date window is unrelated:
        it counts from the event's own day, see `project._habit_day`."""
        if value > server_now() + MAX_FUTURE:
            raise PydanticCustomError("occurred_at_in_future", _FUTURE)
        return value

    @field_validator("tz")
    @classmethod
    def _known_zone(cls, tz: str) -> str:
        if not is_valid_tz(tz):
            raise PydanticCustomError("unknown_tz", "المنطقة الزمنية غير معروفة")
        return tz

    @field_validator("payload")
    @classmethod
    def _storable(cls, payload: dict[str, Any]) -> dict[str, Any]:
        _check_storable(payload)
        return payload

    @model_validator(mode="after")
    def _projectable(self) -> "EventIn":
        """Reject at the door what could not be projected; `source` does not change validity."""
        try:
            project_event(self, "web")
        except ProjectionError as exc:
            raise PydanticCustomError(exc.code, exc.message) from None
        return self


class EventBatch(BaseModel):
    """`POST /v1/events` body: at most 500 events (more is a 422, like any other bad body)."""

    events: Annotated[list[EventIn], Field(max_length=MAX_BATCH)]


class BatchResult(BaseModel):
    accepted: int  # new events stored
    duplicates: int  # events whose id was already stored: nothing changed for them


class StoredEvent(BaseModel):
    """An event as stored, with the server-side `received_at` that `GET /v1/events` pages by."""

    id: UUID
    device_id: UUID | None
    type: str
    payload: dict[str, Any]
    occurred_at: datetime
    tz: str
    received_at: datetime


class PullResult(BaseModel):
    events: list[StoredEvent]
    # the last event's `received_at`, or the `since` that was asked for when there is nothing new
    next_since: datetime | None
