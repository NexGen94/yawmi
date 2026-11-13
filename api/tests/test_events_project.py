"""Event envelope validation and the projection decisions: pure, no database.

`project_event` turns a validated event into an intent (which table and row it maps to) that
the store executes; these tests pin every decision, so the DB tests only need the end-to-end
cases.
"""

import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from yawmi.domain.days import day_key
from yawmi.events.models import MAX_BATCH, EventBatch, EventIn, PayloadNotJson, dump_payload
from yawmi.events.project import (
    EVENT_TYPES,
    MAX_BACKDATE_DAYS,
    BreathSession,
    FocusSession,
    GoalTaskMark,
    HabitLog,
    JournalEntry,
    MoodLog,
    Planned,
    ProjectionError,
    habit_codes,
    plan,
    project_event,
)

OCCURRED = "2026-11-10T09:00:00Z"
OCCURRED_AT = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)


def ev(
    type_: str,
    payload: dict[str, Any] | None = None,
    *,
    occurred: str = OCCURRED,
    tz: str | None = None,
    id_: UUID | None = None,
) -> EventIn:
    body: dict[str, Any] = {
        "id": id_ or uuid4(),
        "type": type_,
        "payload": {} if payload is None else payload,
        "occurred_at": occurred,
    }
    if tz is not None:
        body["tz"] = tz
    return EventIn(**body)


def error_types(exc: pytest.ExceptionInfo[ValidationError]) -> list[str]:
    return [error["type"] for error in exc.value.errors()]


def logged(**payload: Any) -> dict[str, Any]:
    return {"habit_code": "H1", "status": "done", **payload}


# --- the envelope ------------------------------------------------------------------------------


def test_the_ten_event_types() -> None:
    assert set(EVENT_TYPES) == {
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
        "journal_saved",
        "goal_task_set",
    }


def test_tz_defaults_to_riyadh() -> None:
    assert ev("app_opened").tz == "Asia/Riyadh"


def test_a_valid_envelope_keeps_its_fields() -> None:
    event_id = uuid4()
    event = ev("mood_logged", {"score": 4}, id_=event_id, tz="Europe/London")
    assert event.id == event_id
    assert event.payload == {"score": 4}
    assert event.occurred_at == OCCURRED_AT
    assert event.tz == "Europe/London"


def test_an_unknown_type_is_rejected() -> None:
    with pytest.raises(ValidationError) as exc:
        ev("not_a_type")
    assert "literal_error" in error_types(exc)


def test_a_naive_occurred_at_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ev("app_opened", occurred="2026-11-10T09:00:00")


@pytest.mark.parametrize("value", [1762765200, 1762765200.5, True])
def test_a_numeric_occurred_at_is_rejected_only_iso_text_is_accepted(value: Any) -> None:
    with pytest.raises(ValidationError) as exc:
        EventIn(id=uuid4(), type="app_opened", payload={}, occurred_at=value)
    assert "datetime_not_iso" in error_types(exc)


def test_a_date_only_occurred_at_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ev("app_opened", occurred="2026-11-10")


def iso(instant: datetime) -> str:
    return instant.isoformat().replace("+00:00", "Z")


def test_an_event_may_be_dated_up_to_24_hours_ahead_of_the_server(server_now: datetime) -> None:
    edge = server_now + timedelta(hours=24)
    assert ev("app_opened", occurred=iso(edge)).occurred_at == edge  # exactly 24 h: accepted
    assert ev("app_opened", occurred=iso(server_now + timedelta(hours=23)))


def test_an_event_dated_more_than_24_hours_ahead_is_rejected(server_now: datetime) -> None:
    with pytest.raises(ValidationError) as exc:
        ev("app_opened", occurred=iso(server_now + timedelta(hours=24, seconds=1)))
    assert "occurred_at_in_future" in error_types(exc)
    with pytest.raises(ValidationError):
        ev("app_opened", occurred="2099-01-01T00:00:00Z")


def test_the_past_is_never_too_old_to_be_accepted(server_now: datetime) -> None:
    """A queue replayed after weeks offline carries old events: only the future is bounded."""
    assert ev("app_opened", occurred=iso(server_now - timedelta(days=400)))


def test_the_future_limit_follows_the_clock_that_is_in_force(
    monkeypatch: pytest.MonkeyPatch, server_now: datetime
) -> None:
    later = server_now + timedelta(days=3)
    event_time = iso(server_now + timedelta(days=2))
    with pytest.raises(ValidationError):
        ev("app_opened", occurred=event_time)
    monkeypatch.setattr("yawmi.events.models.server_now", lambda: later)
    assert ev("app_opened", occurred=event_time)  # two days ahead of then, one day behind now


def test_the_back_date_window_is_anchored_on_the_event_day_not_on_the_server_clock(
    monkeypatch: pytest.MonkeyPatch, server_now: datetime
) -> None:
    """The server is 40 days later than the event: the window still counts from the event."""
    monkeypatch.setattr("yawmi.events.models.server_now", lambda: server_now + timedelta(days=40))
    event_time = "2026-11-10T09:00:00Z"
    ok = project_event(ev("habit_logged", logged(day="2026-11-03"), occurred=event_time), "web")
    assert isinstance(ok, HabitLog)
    assert ok.day == date(2026, 11, 3)  # seven days before the event's day
    with pytest.raises(ValidationError) as exc:
        ev("habit_logged", logged(day="2026-11-02"), occurred=event_time)  # eight days before
    assert "day_out_of_window" in error_types(exc)


def test_the_back_date_window_of_an_event_at_the_future_limit_counts_from_its_own_day(
    server_now: datetime,
) -> None:
    edge = iso(server_now + timedelta(hours=24))  # 2026-11-11T12:00Z, a day ahead of "now"
    assert project_event(ev("habit_logged", logged(day="2026-11-04"), occurred=edge), "web")
    with pytest.raises(ValidationError) as exc:
        ev("habit_logged", logged(day="2026-11-03"), occurred=edge)
    assert "day_out_of_window" in error_types(exc)


@pytest.mark.parametrize("occurred", ["1999-12-31T23:59:59Z", "2100-01-01T00:00:00Z"])
def test_an_implausible_occurred_at_is_rejected(occurred: str) -> None:
    with pytest.raises(ValidationError) as exc:
        ev("app_opened", occurred=occurred)
    assert "datetime_out_of_range" in error_types(exc)


def test_the_extreme_datetimes_that_overflow_utc_conversion_are_rejected() -> None:
    with pytest.raises(ValidationError):
        ev("app_opened", occurred="0001-01-01T00:00:00+03:00")


@pytest.mark.parametrize("tz", ["", "Nowhere/Land", "../x", "Asia"])
def test_an_unknown_tz_is_rejected(tz: str) -> None:
    with pytest.raises(ValidationError) as exc:
        ev("app_opened", tz=tz)
    assert "unknown_tz" in error_types(exc)


def test_a_non_uuid_id_is_rejected() -> None:
    with pytest.raises(ValidationError):
        EventIn(id="not-a-uuid", type="app_opened", payload={}, occurred_at=OCCURRED)


def test_a_non_object_payload_is_rejected() -> None:
    with pytest.raises(ValidationError):
        EventIn(id=uuid4(), type="app_opened", payload=[1, 2], occurred_at=OCCURRED)


@pytest.mark.parametrize(
    "payload",
    [
        {"note": "a" + chr(0) + "b"},  # NUL: Postgres text and jsonb refuse it
        {"nested": {"deep": ["ok", chr(0xD800)]}},  # lone surrogate: cannot be UTF-8 encoded
        {chr(0xDFFF): "key"},  # ... in a key as well
    ],
)
def test_text_postgres_cannot_store_is_rejected(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError) as exc:
        ev("mood_logged", payload)
    assert "payload_text_invalid" in error_types(exc)


@pytest.mark.parametrize(
    "number",
    [float("nan"), float("inf"), float("-inf"), json.loads("1e999"), json.loads("-1e999")],
    ids=["NaN", "Infinity", "-Infinity", "1e999", "-1e999"],
)
def test_numbers_json_cannot_represent_are_rejected(number: float) -> None:
    """Python's parser accepts NaN, Infinity and 1e999; `jsonb` accepts none of them."""
    for payload in (
        {"n": number},
        {"deep": [{"x": [1, number]}]},
        {"nested": {"a": {"b": number}}},
    ):
        with pytest.raises(ValidationError) as exc:
            ev("mood_logged", payload)
        assert "payload_not_finite" in error_types(exc)


def test_a_non_finite_number_in_a_typed_payload_is_rejected_as_well() -> None:
    with pytest.raises(ValidationError) as exc:
        ev("habit_logged", logged(value=float("nan")))
    assert "payload_not_finite" in error_types(exc)


def test_ordinary_numbers_are_still_accepted() -> None:
    assert ev("confounder_tagged", {"a": 0, "b": -1.5, "c": 1e300, "d": [2**40]})


def test_dump_payload_refuses_what_jsonb_cannot_store_and_keeps_arabic_readable() -> None:
    assert dump_payload({"a": "عربي", "n": 1.5}) == '{"a": "عربي", "n": 1.5}'
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(PayloadNotJson):
            dump_payload({"x": bad})


def test_a_payload_over_the_size_cap_is_rejected() -> None:
    with pytest.raises(ValidationError) as exc:
        ev("confounder_tagged", {"note": "x" * 20_000})
    assert "payload_too_large" in error_types(exc)


def test_a_payload_at_the_size_cap_is_accepted() -> None:
    padding = 16 * 1024 - len(json.dumps({"note": ""}))
    assert ev("confounder_tagged", {"note": "x" * padding})


def test_arabic_payload_text_is_accepted() -> None:
    assert ev("confounder_tagged", {"note": "يوم هادئ ومثمر"}).payload["note"] == "يوم هادئ ومثمر"


def test_the_batch_limit_is_500() -> None:
    assert MAX_BATCH == 500
    one = {"id": str(uuid4()), "type": "app_opened", "payload": {}, "occurred_at": OCCURRED}
    assert len(EventBatch(events=[one] * 500).events) == 500
    with pytest.raises(ValidationError) as exc:
        EventBatch(events=[one] * 501)
    assert "too_long" in error_types(exc)


def test_an_empty_batch_is_valid() -> None:
    assert EventBatch(events=[]).events == []


# --- habit_logged / habit_skipped / habit_vacation -------------------------------------------


def test_habit_logged_projects_a_done_row_with_the_event_time_as_logged_at() -> None:
    event = ev("habit_logged", logged(value=2.5))
    intent = project_event(event, "iphone")
    assert isinstance(intent, HabitLog)
    assert intent == HabitLog(
        event_id=event.id,
        habit_code="H1",
        day=date(2026, 11, 10),
        status="done",
        value=Decimal("2.5"),
        source="iphone",
        logged_at=OCCURRED_AT,
    )


def test_the_day_without_a_payload_day_is_the_local_day_of_occurred_at() -> None:
    event = ev("habit_logged", logged(), occurred="2026-11-09T23:30:00Z")
    intent = project_event(event, "iphone")
    assert isinstance(intent, HabitLog)
    assert intent.day == day_key(event.occurred_at, "Asia/Riyadh") == date(2026, 11, 10)


def test_the_local_day_uses_the_event_tz() -> None:
    event = ev("habit_logged", logged(), occurred="2026-11-09T23:30:00Z", tz="America/New_York")
    intent = project_event(event, "iphone")
    assert isinstance(intent, HabitLog)
    assert intent.day == date(2026, 11, 9)


def test_a_payload_day_overrides_the_event_day() -> None:
    """Logging yesterday from today: the row belongs to yesterday."""
    event = ev("habit_logged", logged(day="2026-11-09"))
    intent = project_event(event, "iphone")
    assert isinstance(intent, HabitLog)
    assert intent.day == date(2026, 11, 9)
    assert intent.logged_at == OCCURRED_AT  # still the time the edit was made


def test_back_dating_reaches_seven_days_and_no_further() -> None:
    assert MAX_BACKDATE_DAYS == 7
    ok = project_event(ev("habit_logged", logged(day="2026-11-03")), "iphone")
    assert isinstance(ok, HabitLog)
    assert ok.day == date(2026, 11, 3)
    with pytest.raises(ValidationError) as exc:
        ev("habit_logged", logged(day="2026-11-02"))  # eight days before 2026-11-10
    assert "day_out_of_window" in error_types(exc)


def test_the_window_is_measured_from_the_event_day_not_from_the_server_clock() -> None:
    """A queue replayed days late must not turn an old same-day log into an 'old' edit."""
    event = ev("habit_logged", logged(day="2026-11-01"), occurred="2026-11-08T09:00:00Z")
    intent = project_event(event, "iphone")
    assert isinstance(intent, HabitLog)
    assert intent.day == date(2026, 11, 1)


def test_the_window_edge_follows_the_local_day_not_the_utc_day() -> None:
    # 23:30Z on the 9th is already the 10th in Riyadh: the 3rd is exactly seven days back
    ok = ev("habit_logged", logged(day="2026-11-03"), occurred="2026-11-09T23:30:00Z")
    assert isinstance(project_event(ok, "iphone"), HabitLog)
    with pytest.raises(ValidationError):
        ev("habit_logged", logged(day="2026-11-02"), occurred="2026-11-09T23:30:00Z")


def test_a_day_after_the_event_day_is_rejected() -> None:
    with pytest.raises(ValidationError) as exc:
        ev("habit_logged", logged(day="2026-11-11"))
    assert "day_in_future" in error_types(exc)


@pytest.mark.parametrize("status", ["done", "skip", "vacation"])
def test_habit_logged_carries_its_status(status: str) -> None:
    intent = project_event(ev("habit_logged", logged(status=status)), "web")
    assert isinstance(intent, HabitLog)
    assert intent.status == status


@pytest.mark.parametrize("status", ["skip", "vacation"])
def test_habit_logged_with_a_status_other_than_done_stores_no_value(status: str) -> None:
    """A skipped or vacation day carries no amount: a stray value must not reach the row."""
    intent = project_event(ev("habit_logged", logged(status=status, value=3)), "iphone")
    assert isinstance(intent, HabitLog)
    assert intent.status == status
    assert intent.value is None


def test_habit_logged_done_keeps_its_value_including_zero() -> None:
    for sent, kept in ((2.5, Decimal("2.5")), (0, Decimal(0)), (None, None)):
        payload = logged(value=sent) if sent is not None else logged()
        intent = project_event(ev("habit_logged", payload), "iphone")
        assert isinstance(intent, HabitLog)
        assert intent.value == kept


@pytest.mark.parametrize(
    ("type_", "status"), [("habit_skipped", "skip"), ("habit_vacation", "vacation")]
)
def test_skip_and_vacation_events_imply_their_status_and_no_value(type_: str, status: str) -> None:
    event = ev(type_, {"habit_code": "H1", "value": 9, "status": "done"})
    intent = project_event(event, "watch")
    assert isinstance(intent, HabitLog)
    assert intent.status == status  # the type decides, not a stray payload field
    assert intent.value is None
    assert intent.source == "watch"


def test_skip_and_vacation_accept_a_back_dated_day() -> None:
    intent = project_event(ev("habit_skipped", {"habit_code": "H1", "day": "2026-11-08"}), "web")
    assert isinstance(intent, HabitLog)
    assert intent.day == date(2026, 11, 8)


@pytest.mark.parametrize("source", ["iphone", "watch", "web"])
def test_the_source_is_the_device_kind(source: str) -> None:
    intent = project_event(ev("habit_logged", logged()), source)
    assert isinstance(intent, HabitLog)
    assert intent.source == source


def test_a_missing_value_is_stored_as_null_not_zero() -> None:
    intent = project_event(ev("habit_logged", logged()), "iphone")
    assert isinstance(intent, HabitLog)
    assert intent.value is None


def test_unknown_payload_fields_are_ignored_so_newer_clients_still_work() -> None:
    event = ev("habit_logged", logged(future_field={"a": 1}))
    assert isinstance(project_event(event, "iphone"), HabitLog)


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "done"},  # no habit_code
        {"habit_code": "", "status": "done"},
        {"habit_code": "x" * 65, "status": "done"},
        {"habit_code": "H1"},  # status is required for habit_logged
        {"habit_code": "H1", "status": "missed"},  # 'missed' is written by the server, never sent
        {"habit_code": "H1", "status": "done", "value": -1},
        {"habit_code": "H1", "status": "done", "value": "abc"},
        {"habit_code": "H1", "status": "done", "value": 1e30},
        {"habit_code": "H1", "status": "done", "value": 0.12345678},
        {"habit_code": "H1", "status": "done", "day": "10/11/2026"},
        {"habit_code": 7, "status": "done"},
    ],
)
def test_an_invalid_habit_payload_is_rejected(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError) as exc:
        ev("habit_logged", payload)
    assert "invalid_payload" in error_types(exc)


def test_habit_skipped_needs_a_habit_code() -> None:
    with pytest.raises(ValidationError):
        ev("habit_skipped", {})


# --- events stored only in `events` ------------------------------------------------------------


@pytest.mark.parametrize(
    "type_", ["day_closed", "focus_started", "confounder_tagged", "app_opened"]
)
def test_other_types_have_no_projection_and_any_object_payload(type_: str) -> None:
    for payload in ({}, {"anything": [1, {"x": None}]}):
        assert project_event(ev(type_, payload), "iphone") is None


# --- focus_ended -------------------------------------------------------------------------------


def test_focus_ended_fills_every_column_it_is_given() -> None:
    event = ev(
        "focus_ended",
        {
            "habit_code": "H2",
            "goal_ref": "G7",
            "started_at": "2026-11-10T08:00:00Z",
            "ended_at": "2026-11-10T08:50:00Z",
            "planned_minutes": 45,
            "actual_minutes": 50,
            "focus_rating": 4,
            "next_step": "راجع الملخص",
        },
    )
    intent = project_event(event, "iphone")
    assert intent == FocusSession(
        event_id=event.id,
        habit_code="H2",
        goal_ref="G7",
        day=date(2026, 11, 10),
        started_at=datetime(2026, 11, 10, 8, 0, tzinfo=UTC),
        ended_at=datetime(2026, 11, 10, 8, 50, tzinfo=UTC),
        planned_minutes=45,
        actual_minutes=Decimal(50),
        focus_rating=4,
        next_step="راجع الملخص",
    )


def test_focus_ended_missing_columns_are_null_and_times_fall_back_to_the_event() -> None:
    intent = project_event(ev("focus_ended", {}), "iphone")
    assert isinstance(intent, FocusSession)
    assert intent.started_at == intent.ended_at == OCCURRED_AT
    assert intent.day == date(2026, 11, 10)
    assert intent.habit_code is None
    assert intent.goal_ref is None
    assert intent.planned_minutes is None
    assert intent.actual_minutes is None
    assert intent.focus_rating is None
    assert intent.next_step is None


def test_focus_started_at_is_derived_from_the_actual_minutes() -> None:
    intent = project_event(ev("focus_ended", {"actual_minutes": 25}), "iphone")
    assert isinstance(intent, FocusSession)
    assert intent.ended_at == OCCURRED_AT
    assert intent.started_at == datetime(2026, 11, 10, 8, 35, tzinfo=UTC)


def test_a_session_belongs_to_the_local_day_it_started_on() -> None:
    event = ev(
        "focus_ended",
        {"started_at": "2026-11-09T20:50:00Z", "ended_at": "2026-11-09T21:20:00Z"},
        occurred="2026-11-09T21:20:00Z",
    )
    intent = project_event(event, "iphone")
    assert isinstance(intent, FocusSession)
    assert intent.day == date(2026, 11, 9)  # started 23:50 Riyadh, ended 00:20 the next day


def test_focus_ended_before_it_started_is_rejected() -> None:
    with pytest.raises(ValidationError) as exc:
        ev(
            "focus_ended",
            {"started_at": "2026-11-10T09:30:00Z", "ended_at": "2026-11-10T09:00:00Z"},
        )
    assert "session_bounds" in error_types(exc)


@pytest.mark.parametrize(
    "payload",
    [
        {"focus_rating": 0},
        {"focus_rating": 6},
        {"focus_rating": 3.5},
        {"focus_rating": "4"},
        {"planned_minutes": 0},
        {"planned_minutes": 2**31},
        {"actual_minutes": -1},
        {"started_at": "2026-11-10T08:00:00"},  # naive
        {"next_step": "x" * 501},
        {"habit_code": ""},
    ],
)
def test_an_invalid_focus_payload_is_rejected(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError) as exc:
        ev("focus_ended", payload)
    assert "invalid_payload" in error_types(exc)


# --- breath_ended ------------------------------------------------------------------------------


def test_breath_ended_fills_every_column_it_is_given() -> None:
    event = ev(
        "breath_ended",
        {
            "pattern": "box",
            "started_at": "2026-11-10T08:55:00Z",
            "ended_at": "2026-11-10T09:00:00Z",
            "breaths_per_min": 6,
            "duration_seconds": 300,
            "completed": False,
        },
    )
    intent = project_event(event, "watch")
    assert intent == BreathSession(
        event_id=event.id,
        day=date(2026, 11, 10),
        started_at=datetime(2026, 11, 10, 8, 55, tzinfo=UTC),
        ended_at=OCCURRED_AT,
        pattern="box",
        breaths_per_min=Decimal(6),
        duration_seconds=300,
        completed=False,
    )


def test_breath_ended_defaults() -> None:
    intent = project_event(ev("breath_ended", {"pattern": "4-7-8"}), "watch")
    assert isinstance(intent, BreathSession)
    assert intent.completed is True  # the column default
    assert intent.started_at == intent.ended_at == OCCURRED_AT
    assert intent.breaths_per_min is None
    assert intent.duration_seconds is None


@pytest.mark.parametrize("feeling", ["calmer", "same", "tense"])
def test_breath_ended_carries_the_feeling_of_the_closed_set(feeling: str) -> None:
    intent = project_event(ev("breath_ended", {"pattern": "calm", "feeling": feeling}), "web")
    assert isinstance(intent, BreathSession)
    assert intent.feeling == feeling


def test_breath_ended_feeling_defaults_to_none() -> None:
    intent = project_event(ev("breath_ended", {"pattern": "box"}), "web")
    assert isinstance(intent, BreathSession)
    assert intent.feeling is None


@pytest.mark.parametrize("feeling", ["great", "", "CALMER", 1])
def test_breath_ended_refuses_a_feeling_outside_the_set(feeling: object) -> None:
    with pytest.raises(ValidationError) as exc:
        ev("breath_ended", {"pattern": "calm", "feeling": feeling})
    assert "invalid_payload" in error_types(exc)


def test_breath_started_at_is_derived_from_the_duration() -> None:
    intent = project_event(ev("breath_ended", {"pattern": "box", "duration_seconds": 90}), "watch")
    assert isinstance(intent, BreathSession)
    assert intent.started_at == datetime(2026, 11, 10, 8, 58, 30, tzinfo=UTC)


@pytest.mark.parametrize(
    "payload",
    [
        {},  # pattern is NOT NULL in the schema, so it cannot default to NULL
        {"pattern": ""},
        {"pattern": "box", "breaths_per_min": 0},
        {"pattern": "box", "duration_seconds": -1},
        {"pattern": "box", "completed": "yes"},
        {"pattern": "x" * 65},
    ],
)
def test_an_invalid_breath_payload_is_rejected(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError) as exc:
        ev("breath_ended", payload)
    assert "invalid_payload" in error_types(exc)


# --- plan / habit_codes ------------------------------------------------------------------------


def test_plan_pairs_each_event_with_its_intent_and_position() -> None:
    first = ev("habit_logged", logged())
    second = ev("app_opened")
    third = ev("focus_ended", {"habit_code": "H2"})
    planned = plan([first, second, third], "iphone")
    assert [item.index for item in planned] == [0, 1, 2]
    assert [item.event for item in planned] == [first, second, third]
    assert isinstance(planned[0].intent, HabitLog)
    assert planned[1].intent is None
    assert isinstance(planned[2].intent, FocusSession)


def test_habit_codes_lists_every_habit_an_intent_refers_to() -> None:
    planned = plan(
        [
            ev("habit_logged", logged(habit_code="A")),
            ev("habit_skipped", {"habit_code": "B"}),
            ev("focus_ended", {"habit_code": "C"}),
            ev("focus_ended", {}),
            ev("breath_ended", {"pattern": "box"}),
            ev("app_opened"),
        ],
        "iphone",
    )
    assert habit_codes(planned) == {"A", "B", "C"}
    assert habit_codes(planned[3:]) == set()


def test_project_event_raises_projection_error_with_an_arabic_message() -> None:
    event = ev("habit_logged", logged())
    # change the payload after validation to reach the pure function's own guard
    event.payload = {"habit_code": "H1", "status": "done", "day": "2026-01-01"}
    with pytest.raises(ProjectionError) as exc:
        project_event(event, "iphone")
    assert exc.value.code == "day_out_of_window"
    assert any(0x0600 <= ord(ch) <= 0x06FF for ch in exc.value.message)


def test_planned_is_a_plain_value_object() -> None:
    event = ev("app_opened")
    assert Planned(index=3, event=event, intent=None) == Planned(3, event, None)


# --- journal_saved / mood_logged / goal_task_set -----------------------------------------------


def test_journal_saved_projects_morning_and_evening_entries() -> None:
    morning = ev(
        "journal_saved",
        {"part": "morning", "answers": {"planned_minutes": 90}},
        occurred="2026-11-09T23:30:00Z",
    )
    intent = project_event(morning, "web")
    assert isinstance(intent, JournalEntry)
    assert intent.day == date(2026, 11, 10)
    assert intent.part == "morning"
    assert intent.answers["planned_minutes"] == 90

    evening = ev(
        "journal_saved",
        {
            "part": "evening",
            "answers": {
                "one_minute": False,
                "priorities": [{"title": "قراءة", "state": "done"}],
                "calm": 8,
                "win": "إنجاز المهمة",
                "win_outcome": "O7",
            },
        },
    )
    ev_intent = project_event(evening, "web")
    assert isinstance(ev_intent, JournalEntry)
    assert ev_intent.part == "evening"
    assert ev_intent.answers["calm"] == 8
    assert ev_intent.answers["win_outcome"] == "O7"


def test_mood_logged_projects_score_feelings_and_activities() -> None:
    event = ev(
        "mood_logged",
        {"score": 4, "feelings": ["calm", "grateful"], "activities": ["walk"]},
    )
    intent = project_event(event, "web")
    assert intent == MoodLog(
        event_id=event.id,
        day=date(2026, 11, 10),
        score=4,
        feelings=["calm", "grateful"],
        activities=["walk"],
        logged_at=OCCURRED_AT,
    )


def test_goal_task_set_projects_task_mark() -> None:
    task_id = uuid4()
    event = ev("goal_task_set", {"task_id": str(task_id), "done": True})
    intent = project_event(event, "web")
    assert intent == GoalTaskMark(
        event_id=event.id,
        task_id=task_id,
        done=True,
        logged_at=OCCURRED_AT,
    )


# --- breath safety limits (design §7.5 and §9.5, ruling م5) ------------------------------------


def breath_limit_refused(payload: dict[str, Any]) -> bool:
    try:
        ev("breath_ended", payload)
    except ValidationError as exc:
        assert "breath_limit" in str(exc), exc
        return True
    return False


@pytest.mark.parametrize(("pattern", "cap"), [("hold_test", 30), ("exhale_test", 60)])
def test_the_tests_stop_at_their_cap(pattern: str, cap: int) -> None:
    assert not breath_limit_refused({"pattern": pattern, "duration_seconds": cap})
    assert breath_limit_refused({"pattern": pattern, "duration_seconds": cap + 1})


def test_the_reviewers_probes_are_refused() -> None:
    assert breath_limit_refused({"pattern": "hold_test", "duration_seconds": 600})
    assert breath_limit_refused({"pattern": "calm", "breaths_per_min": 20})


@pytest.mark.parametrize("pattern", ["calm", "focus", "sleep", "energize", "unwind", "prepare"])
def test_a_named_pattern_breathes_between_5_and_6_5_a_minute(pattern: str) -> None:
    for ok in (5, 5.5, 6, 6.5):
        assert not breath_limit_refused({"pattern": pattern, "breaths_per_min": ok})
    for bad in (4.999, 6.501, 7, 20):
        assert breath_limit_refused({"pattern": pattern, "breaths_per_min": bad})


@pytest.mark.parametrize("pattern", ["box", "4-7-8", "my_custom"])
def test_free_text_patterns_keep_their_old_freedom(pattern: str) -> None:
    for rate in (1, 20, 60):
        assert not breath_limit_refused({"pattern": pattern, "breaths_per_min": rate})
    assert not breath_limit_refused({"pattern": pattern, "duration_seconds": 3600})


def test_a_limited_pattern_without_the_measure_is_accepted() -> None:
    assert not breath_limit_refused({"pattern": "hold_test"})
    assert not breath_limit_refused({"pattern": "calm"})
