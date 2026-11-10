"""`GET /v1/today` and `GET /v1/overview`.

The assembly tests are pure. The API tests run twice through the `backend` fixture: against the
in-memory reader (always) and against Postgres (when `TEST_DATABASE_URL` is set; under CI they
fail rather than skip without it), with identical assertions. Postgres rows are written as the
admin role; the column grants themselves are covered by `test_migrations.py`, and the SQL here
is checked statically never to name `props` or `note`.

`TEST_DATABASE_URL` must point at a throwaway database, never the real `raqib`: these tests
write and delete rows in `raqib.goals`, `raqib.cycles`, the Notion mirror and `yawmi.*`.
"""

import json
import os
import re
from collections.abc import AsyncIterator
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol
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
from yawmi.main import create_app
from yawmi.settings import Settings
from yawmi.today.assemble import (
    build_cards,
    build_habits_due,
    build_outcomes,
    build_plan,
    current_cycle,
    outcome_number,
)
from yawmi.today.memory import InMemoryTodayReader
from yawmi.today.reader import (
    ALL_SQL,
    CardRow,
    CycleRow,
    GoalRow,
    HabitRow,
    LogRow,
    MetricsRow,
    MilestoneRow,
    TodayReader,
)

SECRET = "test-secret-for-unit-tests-only-0123456789"
DAY = date(2026, 11, 10)  # 2026-11-10T12:00Z (conftest) is 15:00 in Riyadh, a Tuesday
PREFIX = "t8b-"


def habit(code: str, **override: Any) -> HabitRow:
    values: dict[str, Any] = {
        "code": PREFIX + code,
        "title_ar": "عادة " + code,
        "kind": "boolean",
        "unit": None,
        "target_per_period": Decimal(1),
        "period": "day",
        "schedule_kind": "every_day",
        "weekday_mask": None,
        "every_n": None,
        "anchor_day": None,
        "start_day": date(2026, 11, 1),
        "end_day": None,
    }
    values.update(override)
    return HabitRow(**values)


def log(code: str, day: date = DAY, status: str = "done", value: str | None = None) -> LogRow:
    return LogRow(PREFIX + code, day, None if value is None else Decimal(value), status)


CYCLE1 = CycleRow(1, date(2026, 10, 31), date(2026, 12, 26), date(2027, 1, 2))
CYCLE2 = CycleRow(2, date(2027, 1, 3), date(2027, 3, 27), date(2027, 4, 3))


def milestone(
    pid: str,
    outcome: str | None,
    *,
    cycle: int | None = 1,
    due: date | None = None,
    done: bool = False,
) -> MilestoneRow:
    return MilestoneRow(PREFIX + pid, "محطة " + pid, outcome, cycle, due, done)


# --- assembly (pure) ---------------------------------------------------------------------------


def test_habits_due_follow_the_schedule_and_the_window() -> None:
    tuesday_bit = 1 << 2  # bit 0 = Sunday
    rows = [
        habit("a-daily"),
        habit("b-tuesdays", schedule_kind="weekdays", weekday_mask=tuesday_bit),
        habit("c-mondays", schedule_kind="weekdays", weekday_mask=1 << 1),
        habit("d-every3", schedule_kind="every_n_days", every_n=3, anchor_day=date(2026, 11, 7)),
        habit(
            "e-every3-off", schedule_kind="every_n_days", every_n=3, anchor_day=date(2026, 11, 8)
        ),
        habit(
            "f-weekly", kind="count", unit="session", target_per_period=Decimal(3), period="week"
        ),
        habit("g-not-started", start_day=DAY + timedelta(days=1)),
        habit("h-ended", end_day=DAY - timedelta(days=1)),
    ]
    due = build_habits_due(DAY, rows, [])
    assert [h.code for h in due] == [
        PREFIX + c for c in ("a-daily", "b-tuesdays", "d-every3", "f-weekly")
    ]
    weekly = due[-1]
    assert (weekly.kind, weekly.unit, weekly.target_per_period, weekly.period) == (
        "count",
        "session",
        3.0,
        "week",
    )


def test_done_today_needs_a_done_log_on_the_day() -> None:
    rows = [habit("a"), habit("b"), habit("c"), habit("d")]
    logs = [
        log("a"),
        log("b", status="skip"),
        log("c", day=DAY - timedelta(days=1)),
        log("d", status="done", value="2"),
    ]
    assert {h.code: h.done_today for h in build_habits_due(DAY, rows, logs)} == {
        PREFIX + "a": True,
        PREFIX + "b": False,
        PREFIX + "c": False,
        PREFIX + "d": True,
    }


@pytest.mark.parametrize(
    ("day", "cycle", "day_in_cycle"),
    [
        (date(2026, 10, 30), None, None),
        (date(2026, 10, 31), 1, 1),
        (DAY, 1, 11),
        (date(2027, 1, 2), 1, 64),  # the review week belongs to its cycle
        (date(2027, 1, 3), 2, 1),
    ],
)
def test_plan_finds_the_cycle_and_the_day_in_it(
    day: date, cycle: int | None, day_in_cycle: int | None
) -> None:
    plan = build_plan(day, [CYCLE2, CYCLE1], [])
    assert (plan.cycle, plan.day_in_cycle) == (cycle, day_in_cycle)
    assert (current_cycle(day, [CYCLE1, CYCLE2]) or CYCLE1).cycle_no == (cycle or 1)


def test_focus_outcomes_are_the_open_milestones_of_the_cycle_in_order() -> None:
    milestones = [
        milestone("1", "O10"),
        milestone("2", "O2"),
        milestone("3", "O2"),
        milestone("4", "O3", done=True),
        milestone("5", "O4", cycle=2),
        milestone("6", None),
        milestone("7", "X1"),
    ]
    assert build_plan(DAY, [CYCLE1], milestones).focus_outcomes == ["O2", "O10"]


def test_outcome_number() -> None:
    assert [outcome_number(c) for c in ("O1", "O12", "O13", "O0", "o1", "G1")] == [
        1,
        12,
        None,
        None,
        None,
        None,
    ]


def test_outcomes_have_completion_and_the_next_open_milestone() -> None:
    goals = [
        GoalRow("O2", "الصحة النفسية", date(2031, 12, 14), "active"),
        GoalRow("O1", "الصحة الجسدية", date(2031, 12, 14), "active"),
        GoalRow("O3", "نظام", date(2031, 12, 20), "active"),
        GoalRow("weight", "ليس مخرجاً", date(2031, 1, 1), "active"),
    ]
    milestones = [
        milestone("a", "O1", due=date(2027, 1, 1), done=True),
        milestone("b", "O1", due=date(2027, 3, 1)),
        milestone("c", "O1", due=date(2026, 12, 1)),
        milestone("d", "O1", due=None, cycle=1),
        milestone("e", "O2", due=None, cycle=3),
        milestone("f", "O2", due=None, cycle=2),
    ]
    out = build_outcomes(goals, milestones)
    assert [o.code for o in out] == ["O1", "O2", "O3"]
    o1, o2, o3 = out
    assert (o1.milestones_total, o1.milestones_done, o1.completion) == (4, 1, 0.25)
    assert o1.next_milestone is not None and o1.next_milestone.page_id == PREFIX + "c"
    assert o2.next_milestone is not None and o2.next_milestone.page_id == PREFIX + "f"
    assert (o3.milestones_total, o3.completion, o3.next_milestone) == (0, None, None)


def test_no_query_reads_the_private_columns_or_selects_star() -> None:
    """`notion_cards.props` and `kpi_readings.note` are not granted to `yawmi_api`."""
    for sql in ALL_SQL:
        words = set(re.findall(r"[a-z_]+", sql.lower()))
        assert "props" not in words, sql
        assert "note" not in words, sql
        assert "*" not in sql, sql


# --- backends ----------------------------------------------------------------------------------


class Backend(Protocol):
    def reader(self) -> TodayReader | None: ...
    async def add(self, *rows: object) -> None: ...
    async def add_card(self, card: CardRow, props: dict[str, Any]) -> None: ...


class MemoryBackend:
    def __init__(self) -> None:
        self.mem = InMemoryTodayReader()

    def reader(self) -> TodayReader | None:
        return self.mem

    async def add(self, *rows: object) -> None:
        for row in rows:
            match row:
                case HabitRow():
                    self.mem.habits.append(row)
                case LogRow():
                    self.mem.logs.append(row)
                case MetricsRow():
                    self.mem.metrics.append(row)
                case CycleRow():
                    self.mem.cycle_rows.append(row)
                case MilestoneRow():
                    self.mem.milestone_rows.append(row)
                case GoalRow():
                    self.mem.goal_rows.append(row)
                case _:
                    raise TypeError(row)

    async def add_card(self, card: CardRow, props: dict[str, Any]) -> None:
        self.mem.card_rows.append(card)


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.days: list[date] = []
        self.cycles: list[int] = []
        self.goals: list[str] = []

    def reader(self) -> TodayReader | None:
        return None  # the route builds `AsyncpgTodayReader` over the pool set by the fixture

    async def add(self, *rows: object) -> None:
        for row in rows:
            match row:
                case HabitRow():
                    await self.pool.execute(
                        "INSERT INTO yawmi.habits (code, title_ar, kind, unit, target_per_period,"
                        " period, schedule_kind, weekday_mask, every_n, anchor_day, start_day,"
                        " end_day, goal_ref, created_by) VALUES"
                        " ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'user')",
                        row.code,
                        row.title_ar,
                        row.kind,
                        row.unit,
                        row.target_per_period,
                        row.period,
                        row.schedule_kind,
                        row.weekday_mask,
                        row.every_n,
                        row.anchor_day,
                        row.start_day,
                        row.end_day,
                        row.goal_ref,
                    )
                case LogRow():
                    await self.pool.execute(
                        "INSERT INTO yawmi.habit_logs (id, habit_code, day, value, status, source,"
                        " logged_at) VALUES ($1, $2, $3, $4, $5, $6, now())",
                        uuid4(),
                        row.habit_code,
                        row.day,
                        row.value,
                        row.status,
                        f"src-{uuid4().hex[:6]}",
                    )
                case MetricsRow():
                    await self.pool.execute(
                        "INSERT INTO yawmi.daily_metrics (day, recovery_score, strain_score,"
                        " sleep_minutes, data_quality) VALUES ($1, $2, $3, $4, $5)",
                        row.day,
                        row.recovery_score,
                        row.strain_score,
                        row.sleep_minutes,
                        row.data_quality,
                    )
                    self.days.append(row.day)
                case CycleRow():
                    await self.pool.execute(
                        "INSERT INTO raqib.cycles (cycle_no, stage_no, start_date, end_date,"
                        " review_start, review_end, theme, gate) VALUES"
                        " ($1, 1, $2, $3, $3 + 1, $4, 'موضوع', 'بوابة')",
                        row.cycle_no,
                        row.start_date,
                        row.end_date,
                        row.review_end,
                    )
                    self.cycles.append(row.cycle_no)
                case MilestoneRow():
                    await self.pool.execute(
                        "INSERT INTO raqib.notion_milestones (page_id, title, outcome_code,"
                        " cycle_no, due_date, done) VALUES ($1, $2, $3, $4, $5, $6)",
                        row.page_id,
                        row.title,
                        row.outcome_code,
                        row.cycle_no,
                        row.due_date,
                        row.done,
                    )
                case GoalRow():
                    await self.pool.execute(
                        "INSERT INTO raqib.goals (code, title, track, target_date, acceptance,"
                        " status) VALUES ($1, $2, 'مسار', $3, 'معيار', $4)",
                        row.code,
                        row.title,
                        row.target_date,
                        row.status,
                    )
                    self.goals.append(row.code)
                case _:
                    raise TypeError(row)

    async def add_card(self, card: CardRow, props: dict[str, Any]) -> None:
        await self.pool.execute(
            "INSERT INTO raqib.notion_cards (page_id, title, status, outcome_codes, props)"
            " VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)",
            card.page_id,
            card.title,
            card.status,
            json.dumps(list(card.outcome_codes)),
            json.dumps(props, ensure_ascii=False),
        )

    async def cleanup(self) -> None:
        like = PREFIX + "%"
        await self.pool.execute("DELETE FROM yawmi.habit_logs WHERE habit_code LIKE $1", like)
        await self.pool.execute("DELETE FROM yawmi.habits WHERE code LIKE $1", like)
        # the fixed keys the tests use, so a run aborted before its cleanup cannot block the next
        days = [*self.days, *(DAY - timedelta(days=i) for i in range(7))]
        await self.pool.execute("DELETE FROM yawmi.daily_metrics WHERE day = ANY($1)", days)
        await self.pool.execute("DELETE FROM raqib.notion_milestones WHERE page_id LIKE $1", like)
        await self.pool.execute("DELETE FROM raqib.notion_cards WHERE page_id LIKE $1", like)
        cycles = [*self.cycles, CYCLE1.cycle_no, CYCLE2.cycle_no]
        goals = [*self.goals, "O1", "O2", "O3", "weight"]
        await self.pool.execute("DELETE FROM raqib.cycles WHERE cycle_no = ANY($1)", cycles)
        await self.pool.execute("DELETE FROM raqib.goals WHERE code = ANY($1)", goals)


IN_CI = bool(os.environ.get("CI"))
MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"
STUB_SQL = Path(__file__).parent / "fixtures" / "raqib_stub.sql"


@pytest.fixture(params=["memory", "postgres"])
async def backend(request: pytest.FixtureRequest) -> AsyncIterator[Backend]:
    if request.param == "memory":
        yield MemoryBackend()
        return
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await pool.execute(STUB_SQL.read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.habits') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0001_yawmi_schema.sql").read_text(encoding="utf-8"))
    pg = PostgresBackend(pool)
    await pg.cleanup()
    set_pool(pool)
    try:
        yield pg
    finally:
        set_pool(None)
        await pg.cleanup()
        await pool.close()


@pytest.fixture
def app(backend: Backend) -> FastAPI:
    application = create_app(
        settings=Settings(
            database_url="postgresql://yawmi_api@localhost:5432/raqib",
            jwt_secret=SecretStr(SECRET),
        ),
        devices=InMemoryDeviceStore(),
    )
    reader = backend.reader()
    if reader is not None:
        application.state.today = reader
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def auth(kind: str = "web") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(uuid4(), kind, SECRET, 900)}"}


# --- /v1/today ---------------------------------------------------------------------------------


async def test_today_on_an_empty_system(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/today", headers=auth())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["day"] == "2026-11-10"
    assert body["priorities"] == []
    assert body["plan"] == {"cycle": None, "day_in_cycle": None, "focus_outcomes": []}
    assert body["health"]["data_quality"] == "missing"
    assert body["health"]["recovery_score"] is None
    assert [p["day"] for p in body["health"]["recovery_7d"]] == [
        (DAY - timedelta(days=6 - i)).isoformat() for i in range(7)
    ]
    assert all(p["recovery_score"] is None for p in body["health"]["recovery_7d"])
    assert [h for h in body["habits_due"] if h["code"].startswith(PREFIX)] == []


async def test_today_brings_habits_health_and_plan_together(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    await backend.add(
        habit("read", title_ar="قراءة", kind="duration", unit="min", target_per_period=Decimal(20)),
        habit("run", schedule_kind="weekdays", weekday_mask=1 << 1),  # Mondays only
        log("read", value="25"),
        MetricsRow(DAY, 64, Decimal("8.5"), 431, "ok"),
        MetricsRow(DAY - timedelta(days=2), 58, None, 400, "low"),
        CYCLE1,
        milestone("m1", "O3"),
        milestone("m2", "O1", done=True),
    )
    response = await client.get("/v1/today", headers=auth("iphone"))
    assert response.status_code == 200, response.text
    body = response.json()
    mine = [h for h in body["habits_due"] if h["code"].startswith(PREFIX)]
    assert mine == [
        {
            "code": PREFIX + "read",
            "title_ar": "قراءة",
            "kind": "duration",
            "unit": "min",
            "target_per_period": 20.0,
            "period": "day",
            "done_today": True,
            "period_progress": {
                "done": 25.0,
                "target": 20.0,
                "completion": 1.0,
                "reached": True,
                "expected": 20.0,
                "on_track": True,
                "need_per_day": 0.0,
            },
        }
    ]
    health = body["health"]
    assert (health["data_quality"], health["recovery_score"], health["strain_score"]) == (
        "ok",
        64,
        8.5,
    )
    assert health["sleep_minutes"] == 431
    assert [p["recovery_score"] for p in health["recovery_7d"]] == [
        None,
        None,
        None,
        None,
        58,
        None,
        64,
    ]
    assert body["plan"] == {"cycle": 1, "day_in_cycle": 11, "focus_outcomes": ["O3"]}


@pytest.mark.parametrize(
    ("now", "day"),
    [("2026-11-09T20:59:59+00:00", "2026-11-09"), ("2026-11-09T21:00:00+00:00", "2026-11-10")],
    ids=["23:59:59-riyadh", "00:00-riyadh"],
)
async def test_today_is_the_riyadh_day(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, now: str, day: str
) -> None:
    at = datetime.fromisoformat(now)
    monkeypatch.setattr("yawmi.events.models.server_now", lambda: at)
    response = await client.get("/v1/today", headers=auth())
    assert response.json()["day"] == day
    assert response.json()["health"]["recovery_7d"][-1]["day"] == day


@pytest.mark.parametrize("path", ["/v1/today", "/v1/overview"])
async def test_reads_need_a_device_token(client: httpx.AsyncClient, path: str) -> None:
    assert (await client.get(path)).status_code == 401
    assert (await client.get(path, headers=auth("service"))).status_code == 403
    for kind in ("iphone", "watch", "web"):
        assert (await client.get(path, headers=auth(kind))).status_code == 200


# --- /v1/overview ------------------------------------------------------------------------------


async def test_overview_lists_outcomes_and_cards_without_private_text(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    await backend.add(
        GoalRow("O1", "الصحة الجسدية", date(2031, 12, 14), "active"),
        GoalRow("O2", "الصحة النفسية العالية", date(2031, 12, 14), "active"),
        milestone("a", "O1", due=date(2026, 12, 20), done=True),
        milestone("b", "O1", due=date(2027, 2, 1), cycle=2),
    )
    await backend.add_card(
        CardRow(PREFIX + "card", "بطاقة الصحة", "نشطة", ("O1", "O2")),
        {"السبب العميق": "نص شخصي لا يُقرأ"},
    )
    response = await client.get("/v1/overview", headers=auth())
    assert response.status_code == 200, response.text
    body = response.json()
    assert "نص شخصي" not in response.text
    outcomes = {o["code"]: o for o in body["outcomes"]}
    assert outcomes["O1"] == {
        "code": "O1",
        "title": "الصحة الجسدية",
        "target_date": "2031-12-14",
        "status": "active",
        "milestones_total": 2,
        "milestones_done": 1,
        "completion": 0.5,
        "next_milestone": {
            "page_id": PREFIX + "b",
            "title": "محطة b",
            "due_date": "2027-02-01",
            "cycle_no": 2,
        },
    }
    assert outcomes["O2"]["completion"] is None
    cards = [c for c in body["cards"] if c["page_id"].startswith(PREFIX)]
    assert cards == [
        {
            "page_id": PREFIX + "card",
            "title": "بطاقة الصحة",
            "status": "نشطة",
            "outcome_codes": ["O1", "O2"],
            "habits": [],
            "habits_adherence_avg": None,
        }
    ]


async def test_today_shows_how_far_the_period_has_come(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    await backend.add(
        habit("weekly", kind="count", unit="session", target_per_period=Decimal(4), period="week"),
        habit("month", kind="duration", unit="min", target_per_period=Decimal(300), period="month"),
        log("weekly", day=date(2026, 11, 8), value="1"),  # Sunday: the week started
        log("weekly", day=date(2026, 11, 7), value="5"),  # the week before
        log("month", day=date(2026, 11, 2), value="100"),
        log("month", day=date(2026, 10, 31), value="900"),  # the month before
    )
    body = (await client.get("/v1/today", headers=auth())).json()
    due = {h["code"]: h for h in body["habits_due"] if h["code"].startswith(PREFIX)}
    weekly = due[PREFIX + "weekly"]
    assert weekly["done_today"] is False
    # 1 of 4; 2 of 7 days elapsed before today (no log today) and 5 days left, today included
    assert weekly["period_progress"] == {
        "done": 1.0,
        "target": 4.0,
        "completion": 0.25,
        "reached": False,
        "expected": 4 * 2 / 7,
        "on_track": False,
        "need_per_day": 3 / 5,
    }
    month = due[PREFIX + "month"]["period_progress"]
    # the habit started on 2026-11-01, so November is a full month: 100 of 300
    assert (month["done"], month["target"], month["need_per_day"]) == (100.0, 300.0, 200 / 21)


async def test_overview_cards_carry_their_habits_and_the_average_adherence(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    card = PREFIX + "card"
    await backend.add(
        habit("a", goal_ref=card, start_day=date(2026, 11, 7)),
        habit(
            "b",
            goal_ref=card,
            kind="count",
            unit="session",
            target_per_period=Decimal(3),
            period="week",
            start_day=DAY,
        ),
        habit("c", goal_ref=PREFIX + "other", start_day=date(2026, 11, 7)),
        habit("d"),
        log("a", day=date(2026, 11, 7)),
        log("a", day=date(2026, 11, 8)),
        log("a", day=date(2026, 11, 9), status="missed"),
        log("c", day=date(2026, 11, 7)),
    )
    await backend.add_card(CardRow(card, "بطاقة", None, ("O1",)), {})
    await backend.add_card(CardRow(PREFIX + "empty", "بطاقة بلا عادات", None, ()), {})
    body = (await client.get("/v1/overview", headers=auth())).json()
    cards = {c["page_id"]: c for c in body["cards"] if c["page_id"].startswith(PREFIX)}
    assert cards[card]["habits"] == [
        {"code": PREFIX + "a", "title_ar": "عادة a", "adherence": 2 / 3},
        {"code": PREFIX + "b", "title_ar": "عادة b", "adherence": None},
    ]
    assert cards[card]["habits_adherence_avg"] == 2 / 3
    assert (cards[PREFIX + "empty"]["habits"], cards[PREFIX + "empty"]["habits_adherence_avg"]) == (
        [],
        None,
    )


def test_cards_average_only_the_habits_with_an_adherence() -> None:
    card = CardRow("p", "بطاقة", None, ())
    rows = [
        habit("x", goal_ref="p", start_day=date(2026, 11, 8)),
        habit("y", goal_ref="p", start_day=date(2026, 11, 8)),
        habit("z", goal_ref="p", start_day=DAY),
    ]
    logs = [log("x", day=date(2026, 11, 8)), log("x", day=date(2026, 11, 9))]
    (out,) = build_cards([card], rows, logs, DAY, "sun")
    assert [h.adherence for h in out.habits] == [1.0, 0.0, None]
    assert out.habits_adherence_avg == 0.5


async def test_archived_habits_are_not_linked() -> None:
    reader = InMemoryTodayReader(
        habits=[habit("x", goal_ref="p"), habit("y", goal_ref="p"), habit("z")],
        inactive={PREFIX + "y"},
    )
    assert [h.code for h in await reader.linked_habits()] == [PREFIX + "x"]
