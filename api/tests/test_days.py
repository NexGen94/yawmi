"""`day_key`: the local calendar day of an instant. Pure, no I/O."""

from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from yawmi.domain.days import DEFAULT_TZ, day_key, is_valid_tz


def utc(text: str) -> datetime:
    return datetime.fromisoformat(text)


def test_the_task_boundary_case() -> None:
    assert day_key(datetime(2026, 11, 9, 23, 30, tzinfo=UTC), "Asia/Riyadh") == date(2026, 11, 10)


@pytest.mark.parametrize(
    ("instant", "expected"),
    [
        ("2026-11-09T20:59:59Z", date(2026, 11, 9)),  # 23:59:59 in Riyadh
        ("2026-11-09T21:00:00Z", date(2026, 11, 10)),  # Riyadh midnight
        ("2026-11-10T20:59:59.999999Z", date(2026, 11, 10)),
        ("2026-11-10T21:00:00Z", date(2026, 11, 11)),
        ("2026-12-31T21:00:00Z", date(2027, 1, 1)),  # year boundary
    ],
)
def test_riyadh_midnight_is_2100_utc(instant: str, expected: date) -> None:
    assert day_key(utc(instant), "Asia/Riyadh") == expected


def test_the_day_follows_the_instant_not_the_offset_it_was_written_in() -> None:
    same_instant = [
        datetime(2026, 11, 10, 0, 30, tzinfo=timezone(timedelta(hours=3))),
        datetime(2026, 11, 9, 21, 30, tzinfo=UTC),
        datetime(2026, 11, 9, 16, 30, tzinfo=timezone(timedelta(hours=-5))),
    ]
    assert {day_key(instant, "Asia/Riyadh") for instant in same_instant} == {date(2026, 11, 10)}


def test_riyadh_has_no_daylight_saving_all_year() -> None:
    for month in range(1, 13):
        midnight_utc = datetime(2026, month, 15, 21, 0, tzinfo=UTC)
        assert day_key(midnight_utc - timedelta(seconds=1), "Asia/Riyadh") == date(2026, month, 15)
        assert day_key(midnight_utc, "Asia/Riyadh") == date(2026, month, 16)


def test_other_zones_use_their_own_rules() -> None:
    # 03:30 UTC in July is 23:30 the day before in New York (EDT, UTC-4)
    assert day_key(datetime(2026, 7, 1, 3, 30, tzinfo=UTC), "America/New_York") == date(2026, 6, 30)
    # the same wall clock in January (EST, UTC-5) is also the day before
    assert day_key(datetime(2026, 1, 1, 4, 30, tzinfo=UTC), "America/New_York") == date(
        2025, 12, 31
    )
    assert day_key(datetime(2026, 1, 1, 5, 0, tzinfo=UTC), "America/New_York") == date(2026, 1, 1)


def test_naive_instants_are_refused_rather_than_guessed() -> None:
    with pytest.raises(ValueError, match="aware"):
        day_key(datetime(2026, 11, 10, 9, 0), "Asia/Riyadh")


@pytest.mark.parametrize("tz", ["", "Nowhere/Land", "../etc/passwd", "Asia", "UTC+3 "])
def test_unknown_or_malformed_zones_raise_value_error(tz: str) -> None:
    with pytest.raises(ValueError, match="tz"):
        day_key(datetime(2026, 11, 10, 9, 0, tzinfo=UTC), tz)
    assert is_valid_tz(tz) is False


def test_valid_zones() -> None:
    assert is_valid_tz("Asia/Riyadh")
    assert is_valid_tz("UTC")
    assert is_valid_tz("Europe/London")


def test_default_zone_is_riyadh() -> None:
    assert DEFAULT_TZ == "Asia/Riyadh"
