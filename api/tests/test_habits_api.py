"""`/v1/habits` (list, create, edit, progress) and `POST /v1/goals/{ref}/to-habit`.

Every API test runs twice through the `backend` fixture: against the in-memory store and mirror
(always) and against Postgres (when `TEST_DATABASE_URL` is set; under CI they fail rather than
skip without it). Postgres rows are written as the admin role; the grants themselves are covered
by `test_migrations.py`, and the SQL here is checked statically never to name `props` or `note`.

`TEST_DATABASE_URL` must point at a throwaway database: these tests write and delete rows in
`yawmi.habits` (titles starting with `t10b-`), the seeded system habits, the Notion mirror
(`t10b-` page ids), `raqib.goals` (`O9`) and `raqib.kpis`/`raqib.kpi_readings` (`t10b-` codes).
"""

import os
import re
from collections.abc import AsyncIterator
from datetime import date
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
from yawmi.db.seed import load_habits, seed_habits
from yawmi.habits.memory import InMemoryHabitStore, InMemoryMirrorReader
from yawmi.habits.store import ALL_SQL, CardRef, MilestoneRef, StoredHabit
from yawmi.main import create_app
from yawmi.settings import Settings
from yawmi.today.reader import LogRow

SECRET = "test-secret-for-unit-tests-only-0123456789"
DAY = date(2026, 11, 10)  # 2026-11-10T12:00Z (conftest) is 15:00 in Riyadh, a Tuesday
TITLE = "t10b-"
PAGE = "t10b-"
KPI = "t10b-kpi"
SYSTEM_START = date(2026, 11, 1)
SYSTEM_LOCKED = "عادة نظامية: يُعدَّل المرسى والتذكيرات فقط"


def body(**override: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "title_ar": TITLE + "قراءة",
        "kind": "boolean",
        "period": "day",
        "target_per_period": 1,
    }
    values.update(override)
    return values


def error_types(response: httpx.Response) -> list[tuple[list[str | int], str]]:
    payload = response.json()
    assert payload["detail"] == "طلب غير صالح", payload
    return [(e["loc"], e["type"]) for e in payload["errors"]]


def test_no_query_reads_the_private_columns_or_selects_star() -> None:
    for sql in ALL_SQL:
        words = set(re.findall(r"[a-z_]+", sql.lower()))
        assert "props" not in words, sql
        assert "note" not in words, sql
        assert "*" not in sql, sql


# --- backends ----------------------------------------------------------------------------------


class Backend(Protocol):
    def install(self, app: FastAPI) -> None: ...
    async def add_log(self, code: str, day: date, status: str, value: str | None) -> None: ...
    async def add_milestone(self, ref: MilestoneRef, page_id: str) -> None: ...
    async def add_card(self, ref: CardRef, page_id: str) -> None: ...
    async def add_goal(self, code: str, target_date: date) -> None: ...
    async def add_kpi(
        self, code: str, target: str | None, readings: list[tuple[date, str]]
    ) -> None: ...


def system_habits() -> list[StoredHabit]:
    return [
        StoredHabit(
            code=h["code"],
            title_ar=h["title_ar"],
            goal_ref=h["goal_ref"],
            outcome=h["outcome"],
            ac_ref=h["ac_ref"],
            kind=h["kind"],
            unit=h["unit"],
            target_per_period=Decimal(str(h["target_per_period"])),
            period=h["period"],
            schedule_kind=h["schedule_kind"],
            weekday_mask=h["weekday_mask"],
            every_n=h["every_n"],
            anchor_day=h["anchor_day"],
            anchor=h["anchor"],
            start_day=SYSTEM_START,
            end_day=h["end_day"],
            system=True,
            created_by="seed",
            active=True,
        )
        for h in load_habits()
    ]


class MemoryBackend:
    def __init__(self) -> None:
        self.store = InMemoryHabitStore()
        for habit in system_habits():
            self.store.habits[habit.code] = habit
        self.mirror = InMemoryMirrorReader()

    def install(self, app: FastAPI) -> None:
        app.state.habits = self.store
        app.state.mirror = self.mirror

    async def add_log(self, code: str, day: date, status: str, value: str | None) -> None:
        self.store.log_rows.append(
            LogRow(code, day, None if value is None else Decimal(value), status)
        )

    async def add_milestone(self, ref: MilestoneRef, page_id: str) -> None:
        self.mirror.milestones[page_id] = ref

    async def add_card(self, ref: CardRef, page_id: str) -> None:
        self.mirror.cards[page_id] = ref

    async def add_goal(self, code: str, target_date: date) -> None:
        self.mirror.deadlines[code] = target_date

    async def add_kpi(
        self, code: str, target: str | None, readings: list[tuple[date, str]]
    ) -> None:
        self.mirror.kpi_targets[code] = None if target is None else Decimal(target)
        self.mirror.readings[code] = [(d, Decimal(v)) for d, v in readings]


class PostgresBackend:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    def install(self, app: FastAPI) -> None:
        """Nothing to inject: the routes build their Postgres stores over the pool."""

    async def add_log(self, code: str, day: date, status: str, value: str | None) -> None:
        await self.pool.execute(
            "INSERT INTO yawmi.habit_logs (id, habit_code, day, value, status, source, logged_at)"
            " VALUES ($1, $2, $3, $4, $5, $6, now())",
            uuid4(),
            code,
            day,
            None if value is None else Decimal(value),
            status,
            f"src-{uuid4().hex[:6]}",
        )

    async def add_milestone(self, ref: MilestoneRef, page_id: str) -> None:
        await self.pool.execute(
            "INSERT INTO raqib.notion_milestones (page_id, title, outcome_code, due_date)"
            " VALUES ($1, $2, $3, $4)",
            page_id,
            ref.title,
            ref.outcome_code,
            ref.due_date,
        )

    async def add_card(self, ref: CardRef, page_id: str) -> None:
        import json

        await self.pool.execute(
            "INSERT INTO raqib.notion_cards (page_id, title, outcome_codes, props)"
            " VALUES ($1, $2, $3::jsonb, $4::jsonb)",
            page_id,
            ref.title,
            json.dumps(list(ref.outcome_codes)),
            json.dumps({"السبب العميق": "نص شخصي"}, ensure_ascii=False),
        )

    async def add_goal(self, code: str, target_date: date) -> None:
        await self.pool.execute(
            "INSERT INTO raqib.goals (code, title, track, target_date, acceptance)"
            " VALUES ($1, 'مخرج', 'مسار', $2, 'معيار')",
            code,
            target_date,
        )

    async def add_kpi(
        self, code: str, target: str | None, readings: list[tuple[date, str]]
    ) -> None:
        await self.pool.execute(
            "INSERT INTO raqib.kpis (code, name, unit, direction, target, frequency)"
            " VALUES ($1, 'مؤشر', 'صفحة', 'up', $2, 'weekly')",
            code,
            None if target is None else Decimal(target),
        )
        for day, value in readings:
            await self.pool.execute(
                "INSERT INTO raqib.kpi_readings (kpi_code, reading_date, value, source, note)"
                " VALUES ($1, $2, $3, 'test', 'ملاحظة خاصة')",
                code,
                day,
                Decimal(value),
            )

    async def cleanup(self) -> None:
        user = "SELECT code FROM yawmi.habits WHERE title_ar LIKE $1"
        like = TITLE + "%"
        await self.pool.execute(
            f"DELETE FROM yawmi.habit_logs WHERE habit_code IN ({user}) OR habit_code = ANY($2)",
            like,
            [h.code for h in system_habits()],
        )
        await self.pool.execute(
            f"DELETE FROM yawmi.habit_reminders WHERE habit_code IN ({user})", like
        )
        await self.pool.execute("DELETE FROM yawmi.habits WHERE title_ar LIKE $1", like)
        await self.pool.execute(
            "UPDATE yawmi.habits SET anchor = NULL, start_day = $1 WHERE code = 'english_minutes'",
            SYSTEM_START,
        )
        await self.pool.execute("DELETE FROM raqib.kpi_readings WHERE kpi_code LIKE $1", like)
        await self.pool.execute("DELETE FROM raqib.kpis WHERE code LIKE $1", like)
        await self.pool.execute("DELETE FROM raqib.notion_milestones WHERE page_id LIKE $1", like)
        await self.pool.execute("DELETE FROM raqib.notion_cards WHERE page_id LIKE $1", like)
        await self.pool.execute("DELETE FROM raqib.goals WHERE code = 'O9'")


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
    await seed_habits(pool)
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
    backend.install(application)
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def auth(kind: str = "web") -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access(uuid4(), kind, SECRET, 900)}"}


async def create(client: httpx.AsyncClient, **override: Any) -> dict[str, Any]:
    response = await client.post("/v1/habits", json=body(**override), headers=auth())
    assert response.status_code == 201, response.text
    return response.json()


# --- auth --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/v1/habits"),
        ("POST", "/v1/habits"),
        ("PATCH", "/v1/habits/english_minutes"),
        ("GET", "/v1/habits/english_minutes/progress"),
        ("POST", f"/v1/goals/{PAGE}m/to-habit"),
    ],
)
async def test_habit_routes_need_a_user_device(
    client: httpx.AsyncClient, method: str, path: str
) -> None:
    assert (await client.request(method, path, json={})).status_code == 401
    response = await client.request(method, path, json={}, headers=auth("service"))
    assert response.status_code == 403


@pytest.mark.parametrize("kind", ["iphone", "watch", "web"])
async def test_every_user_device_reads_the_list(client: httpx.AsyncClient, kind: str) -> None:
    assert (await client.get("/v1/habits", headers=auth(kind))).status_code == 200


# --- create and list ---------------------------------------------------------------------------


async def test_create_returns_201_and_the_habit_is_listed(client: httpx.AsyncClient) -> None:
    created = await create(
        client,
        reminders=[{"time": "07:30", "days_mask": 127}, {"time": "21:05", "days_mask": 62}],
    )
    assert re.fullmatch(r"u_[0-9a-f]{12}", created["code"]), created["code"]
    expected = {
        "code": created["code"],
        "title_ar": TITLE + "قراءة",
        "goal_ref": None,
        "outcome": None,
        "ac_ref": None,
        "kind": "boolean",
        "unit": "",
        "target_per_period": 1.0,
        "period": "day",
        "schedule_kind": "every_day",
        "weekday_mask": None,
        "every_n": None,
        "anchor_day": None,
        "anchor": "free",
        "start_day": "2026-11-10",
        "end_day": None,
        "system": False,
        "created_by": "user",
        "active": True,
        "reminders": [{"time": "07:30", "days_mask": 127}, {"time": "21:05", "days_mask": 62}],
    }
    assert created == expected
    listed = (await client.get("/v1/habits", headers=auth("iphone"))).json()
    assert [h for h in listed if h["code"] == created["code"]] == [expected]
    english = next(h for h in listed if h["code"] == "english_minutes")
    assert (english["system"], english["created_by"], english["unit"], english["anchor"]) == (
        True,
        "seed",
        "min",
        "free",
    )


async def test_create_keeps_every_field_it_was_given(client: httpx.AsyncClient) -> None:
    created = await create(
        client,
        title_ar="  " + TITLE + "جري  ",
        goal_ref=PAGE + "m1",
        outcome="O1",
        ac_ref="AC1.2",
        kind="duration",
        unit="hour",
        target_per_period=2.5,
        schedule_kind="every_n_days",
        every_n=3,
        anchor_day="2026-11-09",
        anchor="after_wake",
        start_day="2026-11-09",
        end_day="2026-12-08",
    )
    assert {k: created[k] for k in created if k not in ("code", "reminders")} == {
        "title_ar": TITLE + "جري",
        "goal_ref": PAGE + "m1",
        "outcome": "O1",
        "ac_ref": "AC1.2",
        "kind": "duration",
        "unit": "hour",
        "target_per_period": 2.5,
        "period": "day",
        "schedule_kind": "every_n_days",
        "weekday_mask": None,
        "every_n": 3,
        "anchor_day": "2026-11-09",
        "anchor": "after_wake",
        "start_day": "2026-11-09",
        "end_day": "2026-12-08",
        "system": False,
        "created_by": "user",
        "active": True,
    }


async def test_fields_of_another_schedule_are_dropped(client: httpx.AsyncClient) -> None:
    created = await create(client, weekday_mask=5, every_n=4, anchor_day="2026-11-01")
    assert (created["weekday_mask"], created["every_n"], created["anchor_day"]) == (None,) * 3


@pytest.mark.parametrize(
    ("override", "loc", "kind"),
    [
        ({"target_per_period": 2}, "target_per_period", "target_boolean_day"),
        ({"period": "week", "target_per_period": 8}, "target_per_period", "target_over_period"),
        ({"period": "month", "target_per_period": 29}, "target_per_period", "target_over_period"),
        ({"period": "week", "target_per_period": 2.5}, "target_per_period", "target_not_integer"),
        ({"unit": "min"}, "unit", "unit_kind_mismatch"),
        ({"kind": "count", "unit": "hour", "target_per_period": 3}, "unit", "unit_kind_mismatch"),
        ({"kind": "duration", "unit": "", "target_per_period": 30}, "unit", "unit_kind_mismatch"),
        (
            {"period": "week", "target_per_period": 3, "schedule_kind": "weekdays"},
            "schedule_kind",
            "schedule_needs_day_period",
        ),
        ({"schedule_kind": "weekdays"}, "weekday_mask", "weekday_mask_required"),
        (
            {"schedule_kind": "every_n_days", "anchor_day": "2026-11-01"},
            "every_n",
            "every_n_required",
        ),
        ({"schedule_kind": "every_n_days", "every_n": 2}, "anchor_day", "anchor_day_required"),
        ({"start_day": "2026-11-10", "end_day": "2026-11-09"}, "end_day", "end_before_start"),
    ],
)
async def test_create_refuses_inconsistent_habits(
    client: httpx.AsyncClient, override: dict[str, Any], loc: str, kind: str
) -> None:
    response = await client.post("/v1/habits", json=body(**override), headers=auth())
    assert response.status_code == 422, response.text
    assert error_types(response) == [(["body", loc], kind)]


@pytest.mark.parametrize(
    "override",
    [
        {"reminders": [{"time": "07:00", "days_mask": 127}] * 4},
        {"reminders": [{"time": "7:00", "days_mask": 127}]},
        {"reminders": [{"time": "24:00", "days_mask": 127}]},
        {"reminders": [{"time": "07:00", "days_mask": 0}]},
        {"reminders": [{"time": "07:00", "days_mask": 128}]},
        {"schedule_kind": "every_n_days", "every_n": 1, "anchor_day": "2026-11-01"},
        {"schedule_kind": "weekdays", "weekday_mask": 0},
        {"kind": "count", "target_per_period": 0},
        {"kind": "count", "target_per_period": -1},
        {"title_ar": "   "},
        {"title_ar": "a\u0000b"},
        {"outcome": "O13"},
        {"kind": "habit"},
        {"system": True},
        {"created_by": "seed"},
        {"anchor": ""},
        {"start_day": "2026-02-30"},
    ],
)
async def test_create_refuses_invalid_fields(
    client: httpx.AsyncClient, override: dict[str, Any]
) -> None:
    response = await client.post("/v1/habits", json=body(**override), headers=auth())
    assert response.status_code == 422, response.text
    assert error_types(response)


async def test_create_refuses_infinite_targets(client: httpx.AsyncClient) -> None:
    raw = '{"title_ar": "t10b-x", "kind": "count", "period": "day", "target_per_period": Infinity}'
    response = await client.post(
        "/v1/habits", content=raw, headers={**auth(), "Content-Type": "application/json"}
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    ("override", "target"),
    [
        ({"period": "week", "target_per_period": 7}, 7.0),
        ({"period": "month", "target_per_period": 28}, 28.0),
        ({"kind": "count", "target_per_period": 2.5}, 2.5),
        ({"kind": "count", "unit": "session", "target_per_period": 3}, 3.0),
        ({"kind": "duration", "unit": "min", "target_per_period": 0.5}, 0.5),
    ],
)
async def test_create_accepts_the_limits(
    client: httpx.AsyncClient, override: dict[str, Any], target: float
) -> None:
    assert (await create(client, **override))["target_per_period"] == target


# --- edit --------------------------------------------------------------------------------------


async def test_system_habit_changes_only_its_anchor_and_reminders(
    client: httpx.AsyncClient,
) -> None:
    path = "/v1/habits/english_minutes"
    locked = await client.patch(path, json={"target_per_period": 300}, headers=auth())
    assert locked.status_code == 409
    assert locked.json() == {"detail": SYSTEM_LOCKED}
    for patch in (
        {"active": False},
        {"title_ar": "عنوان آخر"},
        {"anchor": "after_wake", "end_day": "2027-01-01"},
    ):
        assert (await client.patch(path, json=patch, headers=auth())).status_code == 409, patch

    response = await client.patch(path, json={"anchor": "after_wake"}, headers=auth())
    assert response.status_code == 200, response.text
    assert response.json()["anchor"] == "after_wake"
    assert response.json()["target_per_period"] == 285.0
    # sending a locked field with its current value changes nothing, so it is allowed
    same = await client.patch(
        path,
        json={"anchor": "before_sleep", "target_per_period": 285, "unit": "min"},
        headers=auth(),
    )
    assert same.status_code == 200, same.text
    assert same.json()["anchor"] == "before_sleep"


async def test_patch_edits_a_user_habit_and_replaces_its_reminders(
    client: httpx.AsyncClient,
) -> None:
    created = await create(client, reminders=[{"time": "06:00", "days_mask": 1}])
    path = f"/v1/habits/{created['code']}"
    response = await client.patch(
        path,
        json={
            "period": "week",
            "target_per_period": 4,
            "goal_ref": PAGE + "card",
            "reminders": [{"time": "08:15", "days_mask": 127}, {"time": "20:00", "days_mask": 64}],
        },
        headers=auth("iphone"),
    )
    assert response.status_code == 200, response.text
    edited = response.json()
    assert (edited["period"], edited["target_per_period"], edited["goal_ref"]) == (
        "week",
        4.0,
        PAGE + "card",
    )
    assert edited["reminders"] == [
        {"time": "08:15", "days_mask": 127},
        {"time": "20:00", "days_mask": 64},
    ]
    cleared = await client.patch(path, json={"goal_ref": None, "reminders": []}, headers=auth())
    assert (cleared.json()["goal_ref"], cleared.json()["reminders"]) == (None, [])
    listed = (await client.get("/v1/habits", headers=auth())).json()
    assert [h for h in listed if h["code"] == created["code"]] == [cleared.json()]


async def test_archiving_is_active_false_and_the_habit_stays_listed(
    client: httpx.AsyncClient,
) -> None:
    created = await create(client)
    path = f"/v1/habits/{created['code']}"
    response = await client.patch(path, json={"active": False}, headers=auth())
    assert response.status_code == 200
    listed = (await client.get("/v1/habits", headers=auth())).json()
    assert [h["active"] for h in listed if h["code"] == created["code"]] == [False]
    restored = await client.patch(path, json={"active": True}, headers=auth())
    assert restored.json()["active"] is True


@pytest.mark.parametrize(
    ("patch", "loc", "kind"),
    [
        ({"target_per_period": 3}, "target_per_period", "target_boolean_day"),
        ({"end_day": "2026-01-01"}, "end_day", "end_before_start"),
        ({"schedule_kind": "weekdays"}, "weekday_mask", "weekday_mask_required"),
    ],
)
async def test_patch_validates_the_merged_habit(
    client: httpx.AsyncClient, patch: dict[str, Any], loc: str, kind: str
) -> None:
    created = await create(client)
    response = await client.patch(f"/v1/habits/{created['code']}", json=patch, headers=auth())
    assert response.status_code == 422, response.text
    assert error_types(response) == [(["body", loc], kind)]


@pytest.mark.parametrize(
    "patch",
    [
        {"title_ar": None},
        {"kind": None},
        {"reminders": None},
        {"active": None},
        {"code": "u_000000000000"},
        {"system": False},
        {"every_n": 1},
    ],
)
async def test_patch_refuses_invalid_fields(
    client: httpx.AsyncClient, patch: dict[str, Any]
) -> None:
    created = await create(client)
    response = await client.patch(f"/v1/habits/{created['code']}", json=patch, headers=auth())
    assert response.status_code == 422, response.text
    assert error_types(response)


async def test_unknown_habit_is_404(client: httpx.AsyncClient) -> None:
    for response in (
        await client.patch("/v1/habits/u_ffffffffffff", json={"anchor": "free"}, headers=auth()),
        await client.get("/v1/habits/u_ffffffffffff/progress", headers=auth()),
        await client.get("/v1/habits/a%00b/progress", headers=auth()),
    ):
        assert response.status_code == 404, response.text
        assert response.json() == {"detail": "العادة غير موجودة"}


# --- progress ----------------------------------------------------------------------------------


async def test_progress_returns_the_six_indicators(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    created = await create(client, start_day="2026-11-08", end_day="2026-11-14")
    code = created["code"]
    for day in (date(2026, 11, 8), date(2026, 11, 9), DAY):
        await backend.add_log(code, day, "done", None)
    response = await client.get(f"/v1/habits/{code}/progress", headers=auth("watch"))
    assert response.status_code == 200, response.text
    out = response.json()
    assert set(out) == {
        "period_progress",
        "strength",
        "streak",
        "challenge",
        "adherence",
        "last_8_periods",
    }
    assert out["period_progress"] == {
        "done": 1.0,
        "target": 1.0,
        "completion": 1.0,
        "reached": True,
        "expected": 1.0,
        "on_track": True,
        "need_per_day": 0.0,
    }
    assert out["streak"] == 3
    assert out["adherence"] == 1.0
    assert out["challenge"] == {"achieved": 3, "total": 7, "completion": 3 / 7, "remaining_days": 5}
    assert 0 < out["strength"] < 1
    assert out["last_8_periods"] == [1.0, 1.0, 1.0]


async def test_progress_of_a_weekly_habit_keeps_eight_periods(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    created = await create(
        client, kind="count", period="week", target_per_period=4, start_day="2026-09-01"
    )
    code = created["code"]
    await backend.add_log(code, date(2026, 11, 2), "done", "2")  # the week of 2026-11-01
    await backend.add_log(code, date(2026, 11, 9), "done", "1")  # this week (2026-11-08)
    out = (await client.get(f"/v1/habits/{code}/progress", headers=auth())).json()
    assert out["last_8_periods"] == [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.25]
    assert out["challenge"] is None
    assert out["period_progress"]["done"] == 1.0
    assert out["adherence"] == 0.0


async def test_progress_today_is_validated(client: httpx.AsyncClient) -> None:
    path = "/v1/habits/english_minutes/progress"
    tomorrow = await client.get(path, params={"today": "2026-11-11"}, headers=auth())
    assert tomorrow.status_code == 200, tomorrow.text
    past = await client.get(path, params={"today": "2026-11-05"}, headers=auth())
    assert past.status_code == 200
    ahead = await client.get(path, params={"today": "2026-11-12"}, headers=auth())
    assert ahead.status_code == 422
    assert error_types(ahead) == [(["query", "today"], "day_in_future")]
    for bad in ("2026-02-30", "tomorrow", "1999-12-31"):
        response = await client.get(path, params={"today": bad}, headers=auth())
        assert response.status_code == 422, bad


# --- goal to habit -----------------------------------------------------------------------------


async def test_milestone_with_a_kpi_prefills_a_count_habit(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    await backend.add_milestone(
        MilestoneRef("قراءة 100 كتاب", "O9", date(2026, 12, 31)), PAGE + "m1"
    )
    await backend.add_kpi(
        KPI,
        "100",
        [(date(2026, 10, 1), "10"), (date(2026, 11, 9), "40"), (date(2026, 12, 1), "90")],
    )
    response = await client.post(
        f"/v1/goals/{PAGE}m1/to-habit", json={"kpi_code": KPI, "period": "week"}, headers=auth()
    )
    assert response.status_code == 200, response.text
    # (100 − 40) over the 8 weeks from 2026-11-08 to the week of 2026-12-31: ceil(7.5) = 8
    assert response.json() == {
        "title_ar": "قراءة 100 كتاب",
        "goal_ref": PAGE + "m1",
        "outcome": "O9",
        "ac_ref": None,
        "kind": "count",
        "unit": "",
        "target_per_period": 8.0,
        "period": "week",
        "schedule_kind": "every_day",
        "weekday_mask": None,
        "every_n": None,
        "anchor_day": None,
        "anchor": "free",
        "start_day": "2026-11-10",
        "end_day": None,
        "reminders": [],
    }
    daily = await client.post(
        f"/v1/goals/{PAGE}m1/to-habit", json={"kpi_code": KPI, "period": "day"}, headers=auth()
    )
    assert daily.json()["target_per_period"] == 2.0  # ceil(60 / 52 days)
    default = await client.post(
        f"/v1/goals/{PAGE}m1/to-habit", json={"kpi_code": KPI}, headers=auth()
    )
    assert (default.json()["period"], default.json()["target_per_period"]) == ("week", 8.0)


async def test_milestone_without_a_due_date_uses_the_outcome_deadline(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    await backend.add_goal("O9", date(2027, 1, 31))
    await backend.add_milestone(MilestoneRef("محطة", "O9", None), PAGE + "m2")
    await backend.add_kpi(KPI, "30", [])
    response = await client.post(
        f"/v1/goals/{PAGE}m2/to-habit", json={"kpi_code": KPI, "period": "month"}, headers=auth()
    )
    assert response.status_code == 200, response.text
    assert response.json()["target_per_period"] == 10.0  # 30 over Nov, Dec, Jan


async def test_without_a_usable_kpi_the_draft_is_a_daily_yes_no_habit(
    client: httpx.AsyncClient, backend: Backend
) -> None:
    await backend.add_card(CardRef("بطاقة اللغة", ("O7", "O2")), PAGE + "card")
    await backend.add_kpi(KPI, None, [(date(2026, 11, 1), "3")])
    for payload in (None, {}, {"kpi_code": KPI}, {"kpi_code": "t10b-unknown"}, {"period": "week"}):
        response = await client.post(f"/v1/goals/{PAGE}card/to-habit", json=payload, headers=auth())
        assert response.status_code == 200, (payload, response.text)
        draft = response.json()
        assert (draft["title_ar"], draft["goal_ref"], draft["outcome"]) == (
            "بطاقة اللغة",
            PAGE + "card",
            "O7",
        )
        assert (draft["kind"], draft["unit"], draft["period"], draft["target_per_period"]) == (
            "boolean",
            "",
            "day",
            1.0,
        )


async def test_draft_is_not_saved(client: httpx.AsyncClient, backend: Backend) -> None:
    await backend.add_card(CardRef("بطاقة", ()), PAGE + "card")
    before = (await client.get("/v1/habits", headers=auth())).json()
    response = await client.post(f"/v1/goals/{PAGE}card/to-habit", headers=auth())
    assert response.status_code == 200
    assert response.json()["outcome"] is None
    assert (await client.get("/v1/habits", headers=auth())).json() == before


@pytest.mark.parametrize(
    "payload", [{"period": "year"}, {"kpi_code": ""}, {"kpi_code": "a\u0000"}, {"x": 1}]
)
async def test_to_habit_refuses_invalid_bodies(
    client: httpx.AsyncClient, backend: Backend, payload: dict[str, Any]
) -> None:
    await backend.add_card(CardRef("بطاقة", ()), PAGE + "card")
    response = await client.post(f"/v1/goals/{PAGE}card/to-habit", json=payload, headers=auth())
    assert response.status_code == 422


async def test_unknown_goal_ref_is_404(client: httpx.AsyncClient) -> None:
    for ref in (PAGE + "nowhere", "a%00b"):
        response = await client.post(f"/v1/goals/{ref}/to-habit", json={}, headers=auth())
        assert response.status_code == 404
        assert response.json() == {"detail": "لا محطة ولا بطاقة بهذا المعرّف"}
