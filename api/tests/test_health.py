"""`POST /v1/health/daily` and the scoring around it.

The scoring tests are pure. The API tests run twice through the `backend` fixture: against the
in-memory store (always) and against Postgres (when `TEST_DATABASE_URL` is set; under CI they
fail rather than skip without it), with identical assertions.

`TEST_DATABASE_URL` must point at a throwaway database, never the real `raqib`: the fixture
deletes every `daily_metrics` row in a 61-day range around the pinned day.
"""

import json
import os
from collections.abc import AsyncIterator
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import uuid4

import asyncpg
import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.tokens import issue_access
from yawmi.db.pool import create_pool, set_pool
from yawmi.health.compute import Night, Segment, round_strain, score_day, valid_values, window
from yawmi.health.memory_store import InMemoryHealthStore
from yawmi.health.store import _UPSERT, COLUMNS, AsyncpgHealthStore, DailyRow, HealthStore
from yawmi.main import create_app
from yawmi.settings import Settings

SECRET = "test-secret-for-unit-tests-only-0123456789"
DAY = date(2026, 11, 10)  # the pinned server "today" (conftest: 2026-11-10T12:00Z)
FIRST_DAY = DAY - timedelta(days=60)  # every day a test writes lies in [FIRST_DAY, DAY + 1]


def night(day: date, i: int, quality: str = "ok", **override: Any) -> Night:
    """A night whose values alternate, so every baseline has a spread (sd > 0)."""
    values: dict[str, Any] = {
        "hrv_ms": 50.0 if i % 2 else 60.0,
        "rhr_bpm": 55.0 if i % 2 else 65.0,
        "sleep_minutes": 400 if i % 2 else 440,
    }
    values.update(override)
    return Night(day=day, data_quality=quality, **values)  # type: ignore[arg-type]


def history(count: int, *, before: date = DAY, quality: str = "ok") -> list[Night]:
    """`count` consecutive nights ending the day before `before`."""
    return [night(before - timedelta(days=i), i, quality) for i in range(1, count + 1)]


MEAN_HRV = (50.0 * 60.0) ** 0.5  # the geometric mean: z = 0 on the ln scale
MEAN_RHR = 60.0
MEAN_SLEEP = 420


def score(nights: list[Night], **today: Any) -> Any:
    args: dict[str, Any] = {
        "day": DAY,
        "hrv_ms": MEAN_HRV,
        "rhr_bpm": MEAN_RHR,
        "sleep_minutes": MEAN_SLEEP,
        "has_watch_night": True,
        "hrv_samples": 5,
        "history": nights,
    }
    args.update(today)
    return score_day(**args)


# --- scoring (pure) ----------------------------------------------------------------------------


def test_window_is_the_28_days_before_the_day() -> None:
    assert window(DAY) == (DAY - timedelta(days=28), DAY - timedelta(days=1))


@pytest.mark.parametrize("count", [0, 1, 6])
def test_below_seven_valid_nights_there_is_no_baseline_and_no_recovery(count: int) -> None:
    result = score(history(count))
    assert result.baseline is None
    assert result.recovery_score is None


@pytest.mark.parametrize(
    ("count", "quality"),
    [
        (7, "provisional"),
        (14, "provisional"),
        (24, "provisional"),  # the oldest block [day-28..day-22] holds day-22..day-24 only
        (25, "full"),  # every block now holds at least 4 (D-065)
        (27, "full"),
        (28, "full"),
    ],
)
def test_consecutive_nights_are_full_once_every_week_holds_four(count: int, quality: str) -> None:
    result = score(history(count))
    assert result.baseline is not None
    assert result.baseline.quality == quality
    assert result.baseline.nights == count
    assert result.recovery_score is not None


def test_only_valid_nights_count() -> None:
    """Six `ok` nights plus any number of `low` and `missing` ones is still no baseline."""
    nights = history(6) + [
        night(DAY - timedelta(days=d), d, "low" if d % 2 else "missing") for d in range(7, 29)
    ]
    assert score(nights).baseline is None


def test_nights_outside_the_28_day_window_do_not_count() -> None:
    old = [night(DAY - timedelta(days=d), d) for d in range(29, 60)]
    assert score(history(6) + old).baseline is None
    future = [night(DAY + timedelta(days=d), d) for d in range(10)]  # the day itself, and after
    assert score(history(6) + future).baseline is None


def test_nights_older_than_28_days_do_not_enter_the_baseline() -> None:
    result = score(history(40))
    assert result.baseline is not None
    assert (result.baseline.quality, result.baseline.nights) == ("full", 28)


def test_valid_values_keep_ok_nights_with_a_value_dated_oldest_first() -> None:
    nights = [
        night(DAY - timedelta(days=1), 1),
        night(DAY - timedelta(days=3), 3, sleep_minutes=None),
        night(DAY - timedelta(days=2), 2, "low"),
        night(DAY - timedelta(days=4), 4),
    ]
    assert valid_values(nights, "sleep_minutes") == [
        (DAY - timedelta(days=4), 440.0),
        (DAY - timedelta(days=1), 400.0),
    ]


def test_an_empty_value_is_skipped_not_read_as_zero() -> None:
    nights = history(28)
    gaps = [night(n.day, i, sleep_minutes=None) if i < 22 else n for i, n in enumerate(nights)]
    result = score(gaps)
    assert result.baseline is None  # sleep has only 6 values left


def test_four_valid_nights_in_every_week_make_a_full_baseline() -> None:
    """D-065: 16 nights, 4 in each 7-day block of the window, are enough for `full`."""
    offsets = [28, 26, 24, 22, 21, 19, 17, 15, 14, 12, 10, 8, 7, 5, 3, 1]
    spread = [night(DAY - timedelta(days=o), o) for o in offsets]
    result = score(spread)
    assert result.baseline is not None
    assert (result.baseline.quality, result.baseline.nights) == ("full", 16)
    thin = [n for n in spread if n.day != DAY - timedelta(days=1)]  # last week at 3
    assert score(thin).baseline.quality == "provisional"


def test_lower_resting_heart_rate_raises_recovery() -> None:
    """z_RHR is negated: 55 bpm against a 60 ± 5.09 baseline is good news (62), 65 is not (38)."""
    assert score(history(28), rhr_bpm=55.0).recovery_score == 62
    assert score(history(28), rhr_bpm=65.0).recovery_score == 38


def test_higher_hrv_and_longer_sleep_raise_recovery() -> None:
    assert score(history(28), hrv_ms=70.0).recovery_score > 50
    assert score(history(28), sleep_minutes=480).recovery_score > 50


def test_a_missing_night_has_no_recovery_but_keeps_its_baseline_status() -> None:
    result = score(history(28), has_watch_night=False)
    assert result.data_quality == "missing"
    assert result.recovery_score is None
    assert result.baseline is not None


def test_a_low_quality_night_is_still_scored() -> None:
    result = score(history(28), hrv_samples=2)
    assert result.data_quality == "low"
    assert result.recovery_score == 50


@pytest.mark.parametrize("field", ["hrv_ms", "rhr_bpm", "sleep_minutes"])
def test_a_missing_value_today_means_no_recovery(field: str) -> None:
    assert score(history(28), **{field: None}).recovery_score is None


def test_zero_hrv_today_means_no_recovery_and_zero_hrv_nights_are_skipped() -> None:
    assert score(history(28), hrv_ms=0.0).recovery_score is None
    zeros = [night(n.day, i, hrv_ms=0.0) if i < 22 else n for i, n in enumerate(history(28))]
    assert score(zeros).baseline is None


def test_strain_is_rounded_half_up_to_one_decimal() -> None:
    assert round_strain(0.05) == Decimal("0.1")
    assert round_strain(0.25) == Decimal("0.3")  # banker's rounding would give 0.2
    assert round_strain(20.96) == Decimal("21.0")


def test_strain_uses_the_chosen_coefficients_and_is_none_without_exertion() -> None:
    ten = [Segment(minutes=10, hr_reserve=0.5)]
    assert score([], exertion=ten, coefficients="male").strain_score == Decimal("1.4")
    assert score([], exertion=ten, coefficients="female").strain_score == Decimal("1.7")
    assert score([]).strain_score is None


# --- backends ----------------------------------------------------------------------------------

IN_CI = bool(os.environ.get("CI"))
SCHEMA_SQL = Path(__file__).resolve().parents[1] / "db" / "migrations" / "0001_yawmi_schema.sql"


async def ensure_schema(pool: asyncpg.Pool) -> None:
    if await pool.fetchval("SELECT to_regclass('yawmi.daily_metrics') IS NOT NULL"):
        return
    await pool.execute(SCHEMA_SQL.read_text(encoding="utf-8"))


async def _clear(pool: asyncpg.Pool) -> None:
    await pool.execute(
        "DELETE FROM yawmi.daily_metrics WHERE day BETWEEN $1 AND $2",
        FIRST_DAY,
        DAY + timedelta(days=1),
    )


@pytest.fixture(params=["memory", "postgres"])
async def store(request: pytest.FixtureRequest) -> AsyncIterator[HealthStore]:
    if request.param == "memory":
        yield InMemoryHealthStore()
        return
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await ensure_schema(pool)
    await _clear(pool)
    set_pool(pool)
    try:
        yield AsyncpgHealthStore(pool)
    finally:
        set_pool(None)
        await _clear(pool)
        await pool.close()


@pytest.fixture
def app(store: HealthStore) -> FastAPI:
    application = create_app(
        settings=Settings(
            database_url="postgresql://yawmi_api@localhost:5432/raqib",
            jwt_secret=SecretStr(SECRET),
        ),
        devices=InMemoryDeviceStore(),
    )
    application.state.health = store
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def auth(kind: str = "iphone") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(uuid4(), kind, SECRET, 900)}"}


def body(day: date = DAY, **extra: Any) -> dict[str, Any]:
    return {
        "day": day.isoformat(),
        "has_watch_night": True,
        "hrv_samples": 5,
        "hrv_ms": MEAN_HRV,
        "rhr_bpm": MEAN_RHR,
        "sleep_minutes": MEAN_SLEEP,
        **extra,
    }


async def seed(store: HealthStore, nights: list[Night]) -> None:
    for n in nights:
        await store.save(
            DailyRow(
                day=n.day,
                hrv_ms=None if n.hrv_ms is None else Decimal(repr(n.hrv_ms)),
                rhr_bpm=None if n.rhr_bpm is None else Decimal(repr(n.rhr_bpm)),
                sleep_minutes=n.sleep_minutes,
                data_quality=n.data_quality,
            )
        )


# --- the route ---------------------------------------------------------------------------------


async def test_daily_scores_against_the_stored_nights_and_stores_the_day(
    client: httpx.AsyncClient, store: HealthStore
) -> None:
    await seed(store, history(28))
    response = await client.post(
        "/v1/health/daily",
        json=body(
            rhr_bpm=55.0,
            steps=8000,
            exertion=[{"minutes": 10, "hr_reserve": 0.5}],
            trimp_coefficients="male",
        ),
        headers=auth(),
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "day": "2026-11-10",
        "recovery_score": 62,
        "strain_score": 1.4,
        "data_quality": "ok",
        "baseline": {"quality": "full", "nights": 28},
    }
    stored = [n for n in await store.nights(DAY, DAY)]
    assert stored == [
        Night(day=DAY, hrv_ms=MEAN_HRV, rhr_bpm=55.0, sleep_minutes=MEAN_SLEEP, data_quality="ok")
    ]


async def test_resending_a_day_replaces_it(client: httpx.AsyncClient, store: HealthStore) -> None:
    await client.post("/v1/health/daily", json=body(sleep_minutes=300), headers=auth())
    response = await client.post(
        "/v1/health/daily", json=body(has_watch_night=False, sleep_minutes=None), headers=auth()
    )
    assert response.json()["data_quality"] == "missing"
    assert await store.nights(DAY, DAY) == [
        Night(
            day=DAY, hrv_ms=MEAN_HRV, rhr_bpm=MEAN_RHR, sleep_minutes=None, data_quality="missing"
        )
    ]


async def test_first_days_have_no_baseline(client: httpx.AsyncClient) -> None:
    response = await client.post("/v1/health/daily", json=body(), headers=auth("watch"))
    assert response.status_code == 200
    assert response.json()["baseline"] is None
    assert response.json()["recovery_score"] is None
    assert response.json()["strain_score"] is None


async def test_low_nights_in_the_store_do_not_count(
    client: httpx.AsyncClient, store: HealthStore
) -> None:
    await seed(store, history(6) + history(20, before=DAY - timedelta(days=6), quality="low"))
    response = await client.post("/v1/health/daily", json=body(), headers=auth())
    assert response.json()["baseline"] is None


@pytest.mark.parametrize("kind", ["web", "service"])
async def test_only_native_devices_post_health(client: httpx.AsyncClient, kind: str) -> None:
    response = await client.post("/v1/health/daily", json=body(), headers=auth(kind))
    assert response.status_code == 403


async def test_no_token_is_401(client: httpx.AsyncClient) -> None:
    assert (await client.post("/v1/health/daily", json=body())).status_code == 401


@pytest.mark.parametrize(
    ("extra", "error_type"),
    [
        ({"day": (DAY + timedelta(days=2)).isoformat()}, "day_in_future"),
        ({"day": "1999-12-31"}, "day_out_of_range"),
        ({"rhr_bpm": 0}, "greater_than"),
        ({"hrv_ms": -1}, "greater_than_equal"),
        ({"sleep_minutes": 1441}, "less_than_equal"),
        ({"sleep_minutes": 400.5}, "int_type"),
        ({"has_watch_night": "yes"}, "bool_type"),
        ({"exertion": [{"minutes": 10, "hr_reserve": 0.5}]}, "trimp_coefficients_required"),
        (
            {"exertion": [{"minutes": 10, "hr_reserve": 1.5}], "trimp_coefficients": "male"},
            "less_than_equal",
        ),
        (
            {"sleep_start": "2026-11-10T03:00:00Z", "sleep_end": "2026-11-09T20:00:00Z"},
            "sleep_bounds",
        ),
        ({"sleep_end": "2026-11-11T12:00:01Z"}, "sleep_in_future"),
        ({"sleep_end": "2026-11-10T03:00:00"}, "timezone_aware"),
    ],
)
async def test_bad_bodies_are_a_422_in_the_app_shape(
    client: httpx.AsyncClient, store: HealthStore, extra: dict[str, Any], error_type: str
) -> None:
    response = await client.post("/v1/health/daily", json=body() | extra, headers=auth())
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == "طلب غير صالح"
    assert response.json()["errors"][0]["type"] == error_type
    assert await store.nights(FIRST_DAY, DAY + timedelta(days=1)) == []


async def test_hrv_samples_is_required(client: httpx.AsyncClient) -> None:
    """Without it a worn night would read as `low` and never reach a baseline, silently."""
    payload = body()
    del payload["hrv_samples"]
    response = await client.post("/v1/health/daily", json=payload, headers=auth())
    assert response.status_code == 422
    assert response.json()["errors"][0] == {"loc": ["body", "hrv_samples"], "type": "missing"}


@pytest.mark.parametrize(
    ("extra", "loc"),
    [
        ({"hrv_sdnn_ms": 50}, ["body", "hrv_sdnn_ms"]),
        (
            {
                "exertion": [{"minutes": 10, "hr_reserve": 0.5, "avg_hr": 140}],
                "trimp_coefficients": "male",
            },
            ["body", "exertion", 0, "avg_hr"],
        ),
    ],
    ids=["top-level", "segment"],
)
async def test_unknown_fields_are_a_422_not_lost(
    client: httpx.AsyncClient, extra: dict[str, Any], loc: list[Any]
) -> None:
    response = await client.post("/v1/health/daily", json=body() | extra, headers=auth())
    assert response.status_code == 422
    assert response.json()["errors"][0] == {"loc": loc, "type": "extra_forbidden"}


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity", "1e999"])
async def test_non_finite_numbers_are_a_422(client: httpx.AsyncClient, literal: str) -> None:
    text = json.dumps(body(hrv_ms="@")).replace('"@"', literal)
    response = await client.post(
        "/v1/health/daily",
        content=text,
        headers=auth() | {"Content-Type": "application/json"},
    )
    assert response.status_code == 422


async def test_tomorrow_is_accepted_for_clock_drift(client: httpx.AsyncClient) -> None:
    tomorrow = DAY + timedelta(days=1)
    response = await client.post("/v1/health/daily", json=body(tomorrow), headers=auth())
    assert response.status_code == 200


# --- SQL shape (no database needed) ------------------------------------------------------------


def test_upsert_writes_every_column_and_replaces_all_but_the_key() -> None:
    assert COLUMNS[0] == "day"
    assert "ON CONFLICT (day) DO UPDATE" in _UPSERT
    for column in COLUMNS[1:]:
        assert f"{column} = excluded.{column}" in _UPSERT
    assert "computed_at = excluded.computed_at" in _UPSERT
