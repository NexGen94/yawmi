"""The pace line (design §9.4): pure arithmetic, then `GET /v1/goals/{ref}/pace`."""

from collections.abc import AsyncIterator
from datetime import date
from uuid import UUID

import httpx
import pytest
from api_harness import auth_header as bearer
from api_harness import build_app, http_client
from fastapi import FastAPI
from goals_harness import GoalsBackend

from yawmi.goals.models import PaceOut, PaceReading
from yawmi.goals.pace import pace_line

START, DUE = date(2026, 11, 1), date(2026, 12, 31)


def test_the_first_example_is_behind_the_pace() -> None:
    assert pace_line(START, 0, DUE, 12, date(2026, 11, 16), 2) == (3.0, 8.0, False)


def test_without_a_current_value_only_the_expected_is_known() -> None:
    assert pace_line(START, 0, DUE, 12, date(2026, 11, 16), None) == (3.0, None, None)


def test_after_the_due_day_the_expected_is_the_target() -> None:
    expected, projected, on_pace = pace_line(START, 0, DUE, 12, date(2027, 1, 5), 12)
    assert expected == 12.0 and on_pace is True and projected is not None


def test_on_or_before_the_start_day_there_is_no_projection() -> None:
    expected, projected, on_pace = pace_line(START, 0, DUE, 12, START, 0)
    assert (expected, projected, on_pace) == (0.0, None, True)
    expected, projected, _ = pace_line(START, 0, DUE, 12, date(2026, 10, 20), 1)
    assert (expected, projected) == (0.0, None)


def test_exactly_on_the_pace_is_on_pace() -> None:
    assert pace_line(START, 0, DUE, 12, date(2026, 11, 16), 3)[2] is True


def test_a_degenerate_span_expects_the_target_from_the_start() -> None:
    expected, _, _ = pace_line(START, 0, START, 5, START, 1)
    assert expected == 5.0


@pytest.mark.parametrize("current", [0, 1.5, 7])
def test_projection_scales_linearly(current: float) -> None:
    _, projected, _ = pace_line(START, 0, DUE, 12, date(2026, 11, 16), current)
    assert projected == pytest.approx(current * 4)


# --- the model and the route -------------------------------------------------------------------


def test_the_first_design_example_as_a_pace_out() -> None:
    today = date(2026, 11, 16)
    expected, projected, on_pace = pace_line(START, 0, DUE, 12, today, 2)
    pace = PaceOut(
        basis="kpi",
        kpi_code="workshops_count",
        unit="ورشة",
        start_day=START,
        start_value=0,
        due_day=DUE,
        target_value=12,
        today=today,
        current_value=2,
        expected_today=expected,
        projected_end=projected,
        on_pace=on_pace,
        days_left=(DUE - today).days,
        readings=[PaceReading(day=date(2026, 11, 2), value=1), PaceReading(day=today, value=2)],
    )
    assert (pace.expected_today, pace.projected_end, pace.on_pace) == (3.0, 8.0, False)
    assert pace.days_left == 45 and len(pace.readings) == 2


@pytest.fixture
def app(goals_backend: GoalsBackend) -> FastAPI:
    return build_app(goals_backend.install)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with http_client(app) as c:
        yield c


def auth() -> dict[str, str]:
    return bearer(UUID("00000000-0000-7000-8000-000000000414"))


async def pace(client: httpx.AsyncClient, ref: str, **params: str) -> httpx.Response:
    return await client.get(f"/v1/goals/{ref}/pace", params=params, headers=auth())


async def test_a_cumulative_kpi_is_the_basis_of_the_pace(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.outcome("O12", target=date(2026, 12, 31))
    await b.kpi("workshops_count", "O12", target=12, unit="ورشة")
    await b.reading("workshops_count", date(2026, 11, 1), 1)
    await b.reading("workshops_count", date(2026, 11, 9), 2)
    await b.reading("workshops_count", date(2026, 11, 20), 9)  # after today: not read
    resp = await pace(client, "O12")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["basis"], body["kpi_code"], body["unit"]) == ("kpi", "workshops_count", "ورشة")
    assert (body["start_day"], body["start_value"]) == ("2026-10-31", 0)
    assert (body["due_day"], body["target_value"], body["today"]) == (
        "2026-12-31",
        12,
        "2026-11-10",
    )
    assert body["current_value"] == 2 and body["days_left"] == 51
    assert body["expected_today"] == pytest.approx(12 * 10 / 61)
    assert body["projected_end"] == pytest.approx(2 * 61 / 10)
    assert body["on_pace"] is True
    assert body["readings"] == [
        {"day": "2026-11-01", "value": 1},
        {"day": "2026-11-09", "value": 2},
    ]
    # naming the KPI gives the same answer; an unknown one falls back to the default
    assert (await pace(client, "O12", kpi="workshops_count")).json() == body
    assert (await pace(client, "O12", kpi="nope")).json() == body


async def test_a_kpi_without_readings_has_no_current_value(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await goals_backend.outcome("O12", target=date(2026, 12, 31))
    await goals_backend.kpi("workshops_count", "O12", target=12)
    body = (await pace(client, "O12")).json()
    assert body["current_value"] is None and body["on_pace"] is None
    assert body["projected_end"] is None and body["readings"] == []
    assert body["expected_today"] == pytest.approx(12 * 10 / 61)


async def test_an_outcome_without_a_usable_kpi_is_paced_by_its_milestones(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    b = goals_backend
    await b.outcome("O3", target=date(2026, 12, 31))
    await b.kpi("walks_week", "O3", direction="down", target=3)  # descending: not a pace basis
    await b.kpi("books_done", "O3", direction="up", target=None)  # no single target
    for i in range(4):
        await b.milestone(f"m{i}", "O3", done=i < 3, due=date(2026, 12, 1))
    await b.milestone("other", "O1", done=True)
    body = (await pace(client, "O3")).json()
    assert (body["basis"], body["kpi_code"], body["unit"]) == ("milestones", None, None)
    assert (body["current_value"], body["target_value"]) == (3, 4)
    assert body["start_day"] == "2026-10-31" and body["readings"] == []
    assert body["expected_today"] == pytest.approx(4 * 10 / 61)
    assert body["on_pace"] is True


async def test_an_outcome_with_nothing_to_measure_has_no_current_value(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await goals_backend.outcome("O4")
    body = (await pace(client, "O4")).json()
    # nothing to measure: no value, and never «on pace» by default
    assert (body["basis"], body["target_value"]) == ("milestones", 0)
    assert body["current_value"] is None
    assert body["on_pace"] is None and body["projected_end"] is None
    assert body["readings"] == []


async def test_after_the_due_day_the_days_left_are_negative(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await goals_backend.outcome("O4", target=date(2026, 11, 5))
    body = (await pace(client, "O4")).json()
    assert body["days_left"] == -5 and body["expected_today"] == body["target_value"]


async def test_an_unknown_reference_is_a_404(
    client: httpx.AsyncClient, goals_backend: GoalsBackend
) -> None:
    await goals_backend.outcome("O1")
    for ref in ("O9", "t13_card", "x" * 64):
        assert (await pace(client, ref)).status_code == 404, ref
    assert (await pace(client, "O1")).status_code == 200


async def test_the_pace_needs_a_user_device(client: httpx.AsyncClient) -> None:
    assert (await client.get("/v1/goals/O1/pace")).status_code == 401


def at(monkeypatch: pytest.MonkeyPatch, year: int, month: int, day: int) -> None:
    from datetime import UTC, datetime

    now = datetime(year, month, day, 9, 0, tzinfo=UTC)
    monkeypatch.setattr("yawmi.events.models.server_now", lambda: now)


async def test_the_design_example_through_the_route(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    at(monkeypatch, 2026, 11, 16)
    b = goals_backend
    await b.outcome("O12", target=date(2026, 12, 31))
    await b.kpi("workshops_count", "O12", target=12)
    await b.reading("workshops_count", date(2026, 9, 1), 5)  # before the plan: never read
    await b.reading("workshops_count", date(2026, 11, 2), 1)
    await b.reading("workshops_count", date(2026, 11, 16), 2)
    body = (await pace(client, "O12")).json()
    assert body["expected_today"] == pytest.approx(12 * 16 / 61)  # 3.1475
    assert body["projected_end"] == pytest.approx(7.625)
    assert (body["on_pace"], body["days_left"], body["current_value"]) == (False, 45, 2)
    assert [r["day"] for r in body["readings"]] == ["2026-11-02", "2026-11-16"]


@pytest.mark.parametrize(
    ("code", "kwargs"),
    [
        ("steps_avg", {"target": 8000, "unit": "خطوة", "frequency": "daily"}),  # an average
        (
            "strength_sessions",
            {"target": 2, "unit": "جلسة", "frequency": "weekly"},
        ),  # a weekly count
        ("who5_raw", {"target": 18, "unit": "درجة", "frequency": "cycle"}),  # a level
    ],
)
async def test_rates_averages_and_levels_are_never_a_pace_basis(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, code: str, kwargs: dict[str, object]
) -> None:
    b = goals_backend
    await b.outcome("O1", target=date(2031, 12, 31))
    await b.kpi(code, "O1", **kwargs)
    await b.reading(code, date(2026, 11, 9), 6500)
    for i in range(4):
        await b.milestone(f"m{i}", "O1", done=i < 1)
    for params in ({}, {"kpi": code}):  # asking for it by name does not make it a basis
        body = (await pace(client, "O1", **params)).json()
        assert (body["basis"], body["kpi_code"], body["readings"]) == ("milestones", None, [])
        assert (body["current_value"], body["target_value"]) == (1, 4)
        assert body["due_day"] == "2031-12-31"


async def test_books_done_is_paced_over_the_current_year(
    client: httpx.AsyncClient, goals_backend: GoalsBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    b = goals_backend
    await b.outcome("O6", target=date(2031, 12, 31))
    await b.kpi("books_done", "O6", target=12, unit="كتاب", frequency="monthly")
    await b.reading("books_done", date(2026, 11, 5), 2)
    await b.reading("books_done", date(2027, 1, 20), 1)
    # 2026: from the plan start to 31 December 2026, not to the outcome's due day
    at(monkeypatch, 2026, 11, 10)
    body = (await pace(client, "O6")).json()
    assert (body["basis"], body["kpi_code"]) == ("kpi", "books_done")
    assert (body["start_day"], body["due_day"], body["target_value"]) == (
        "2026-10-31",
        "2026-12-31",
        12,
    )
    assert body["current_value"] == 2 and body["days_left"] == 51
    assert body["expected_today"] == pytest.approx(12 * 10 / 61)
    # 2027: from 1 January, and last year's readings do not count
    at(monkeypatch, 2027, 3, 1)
    body = (await pace(client, "O6")).json()
    assert (body["start_day"], body["due_day"]) == ("2027-01-01", "2027-12-31")
    assert body["current_value"] == 1
    assert [r["day"] for r in body["readings"]] == ["2027-01-20"]
    assert body["expected_today"] == pytest.approx(12 * 59 / 364)
    # 2027 with no reading yet this year: no current value
    at(monkeypatch, 2027, 1, 10)
    await b.reading("books_done", date(2026, 12, 30), 11)
    assert (await pace(client, "O6")).json()["current_value"] is None
