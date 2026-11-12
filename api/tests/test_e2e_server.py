"""The local end-to-end test server (`api/tools/e2e_server.py`) and its helpers.

The server is a test tool: the seeded data, the fake provider, the pair-code route that exists
only on the test app, and the guards that keep it local. The in-memory tests run everywhere; the
Postgres ones run with `TEST_DATABASE_URL` (a throwaway database: they reset the `yawmi` schema).
"""

import inspect
import json
import os
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import asyncpg
import e2e_server
import fake_provider
import httpx
import local_pg
import pytest
from api_harness import IN_CI, SECRET, auth_header
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from yawmi.ai.schema import InsightResponse
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.db.pool import create_pool, set_pool
from yawmi.main import create_app
from yawmi.settings import Settings

TODAY = date(2026, 11, 10)  # the conftest clock: 2026-11-10T12:00Z is 15:00 in Riyadh
OPENAPI = Path(__file__).resolve().parents[2] / "openapi" / "openapi.json"
E2E_CODES = (
    "e2e_tick_desktop",
    "e2e_tick_mobile",
    "e2e_minutes_desktop",
    "e2e_minutes_mobile",
)


def _settings() -> Settings:
    return Settings(
        database_url="postgresql://yawmi_api@localhost:5432/raqib",
        jwt_secret=SecretStr(SECRET),
        cookie_secure=False,
    )


def _memory_app() -> FastAPI:
    app = e2e_server.build_app(_settings(), InMemoryDeviceStore())
    e2e_server.seed_memory(app, TODAY)
    return app


@pytest.fixture
def app() -> FastAPI:
    return _memory_app()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _device() -> dict[str, str]:
    return auth_header(uuid4())


# --- seeded data ---------------------------------------------------------------------------


async def test_overview_has_the_twelve_outcomes_with_the_goal_titles(
    client: httpx.AsyncClient,
) -> None:
    res = await client.get("/v1/overview", headers=_device())
    assert res.status_code == 200
    outcomes = res.json()["outcomes"]
    assert [o["code"] for o in outcomes] == [f"O{n}" for n in range(1, 13)]
    assert [o["title"] for o in outcomes] == list(e2e_server.OUTCOME_TITLES)
    assert outcomes[0]["title"] == "الصحة الجسدية"
    assert len(res.json()["cards"]) == 3


def test_the_mirror_has_21_cycles_6_milestones_one_two_days_late_and_3_cards() -> None:
    mirror = e2e_server.mirror(TODAY)
    assert len(mirror.cycles) == 21
    assert [c["cycle_no"] for c in mirror.cycles] == list(range(1, 22))
    assert mirror.cycles[0]["start_date"] == date(2026, 10, 31)
    assert mirror.cycles[-1]["end_date"] == date(2031, 12, 31)
    assert len(mirror.milestones) == 6
    late = [m for m in mirror.milestones if not m.done and m.due_date and m.due_date < TODAY]
    assert [m.due_date for m in late] == [TODAY - timedelta(days=2)]
    assert len(mirror.cards) == 3
    for card in mirror.cards:
        assert mirror.card_props[card.page_id]["المستهدف"]["start"]
        assert mirror.card_props[card.page_id]["الخطوة التالية"]


async def test_today_lists_the_four_e2e_habits_among_the_due(client: httpx.AsyncClient) -> None:
    res = await client.get("/v1/today", headers=_device())
    assert res.status_code == 200
    due = {h["code"]: h for h in res.json()["habits_due"]}
    assert set(E2E_CODES) <= set(due)
    assert len(due) >= 10 + 4  # the ten system habits and the four of the suite
    for project in ("desktop", "mobile"):
        assert due[f"e2e_tick_{project}"]["kind"] == "boolean"
        assert due[f"e2e_minutes_{project}"]["kind"] == "duration"
        assert due[f"e2e_minutes_{project}"]["unit"] == "min"
    assert res.json()["plan"]["cycle"] == 1


async def test_close_day_returns_the_two_fixed_lines_of_the_fake_provider(
    client: httpx.AsyncClient,
) -> None:
    body = {
        "day": TODAY.isoformat(),
        "context": {},
        "sources": [{"id": "habit:x", "kind": "habit", "text": "عادة: 1 من 1"}],
    }
    res = await client.post("/v1/day/close", json=body, headers=_device())
    assert res.status_code == 200
    out = res.json()
    assert out["lines"] == list(fake_provider.LINES)
    assert len(out["lines"]) == 2
    assert out["source_ids"] == ["habit:x"]


# --- the fake provider -----------------------------------------------------------------------


async def test_fake_provider_cites_the_first_source_of_the_request() -> None:
    provider = fake_provider.FakeProvider()
    user = json.dumps({"sources": [{"id": "a", "kind": "k", "text": "t"}, {"id": "b"}]})
    reply = await provider.complete("system", user, {}, "model")
    assert reply["lines"] == list(fake_provider.LINES)
    assert reply["source_ids"] == ["a"]
    InsightResponse.model_validate(reply)


async def test_fake_provider_without_sources_cites_nothing_and_ignores_a_repair_note() -> None:
    provider = fake_provider.FakeProvider()
    user = json.dumps({"sources": []}) + "\n\n[تصحيح] ..."
    reply = await provider.complete("system", user, {}, "model")
    assert reply["source_ids"] == []
    assert reply["priorities"] == []
    InsightResponse.model_validate(reply)


def test_fake_provider_has_the_provider_signature() -> None:
    params = list(inspect.signature(fake_provider.FakeProvider.complete).parameters)
    assert params == ["self", "system", "user", "schema", "model"]


# --- the pair-code route ---------------------------------------------------------------------


async def test_pair_code_is_accepted_once_and_refused_the_second_time(
    client: httpx.AsyncClient,
) -> None:
    code = (await client.post("/__e2e/pair-code")).json()["code"]
    pair = {"code": code, "name": "متصفح الحاسوب", "kind": "web"}
    first = await client.post("/v1/devices/pair", json=pair)
    assert first.status_code == 200
    assert first.json()["refresh_token"] is None  # a web device: the token is in the cookie
    second = await client.post("/v1/devices/pair", json=pair)
    assert second.status_code == 400


async def test_thirty_issue_and_pair_cycles_never_count_a_failure(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    for _ in range(30):
        code = (await client.post("/__e2e/pair-code")).json()["code"]
        res = await client.post(
            "/v1/devices/pair", json={"code": code, "name": "متصفح الحاسوب", "kind": "web"}
        )
        assert res.status_code == 200
    assert len(app.state.pairing_guard._failures) == 0
    # the fail-closed rule never tripped: a 31st code still pairs
    code = (await client.post("/__e2e/pair-code")).json()["code"]
    last = await client.post(
        "/v1/devices/pair", json={"code": code, "name": "متصفح الحاسوب", "kind": "web"}
    )
    assert last.status_code == 200


async def test_pair_code_is_refused_for_a_non_loopback_caller(app: FastAPI) -> None:
    transport = ASGITransport(app=app, client=("203.0.113.9", 4321))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as remote:
        res = await remote.post("/__e2e/pair-code")
    assert res.status_code == 403
    assert "code" not in res.text


async def test_the_production_app_has_no_e2e_route_and_the_contract_neither(
    app: FastAPI,
) -> None:
    prod = create_app(settings=_settings(), devices=InMemoryDeviceStore())
    async with httpx.AsyncClient(transport=ASGITransport(app=prod), base_url="http://test") as c:
        assert (await c.post("/__e2e/pair-code")).status_code == 404
    assert not [p for p in prod.openapi()["paths"] if "__e2e" in p]
    # the test app serves the route, outside the schema
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        assert (await c.post("/__e2e/pair-code")).status_code == 200
    assert not [p for p in app.openapi()["paths"] if "__e2e" in p]
    assert "__e2e" not in OPENAPI.read_text(encoding="utf-8")


def test_the_tool_refuses_a_host_other_than_loopback() -> None:
    with pytest.raises(SystemExit) as exc:
        e2e_server.parse_args(["--host", "0.0.0.0"])
    assert exc.value.code != 0
    assert e2e_server.parse_args(["--host", "localhost"]).host == "localhost"
    assert e2e_server.parse_args([]).host == "127.0.0.1"
    assert e2e_server.parse_args(["--port", "8001"]).port == 8001


def test_the_tool_refuses_a_database_that_is_not_local() -> None:
    with pytest.raises(SystemExit):
        e2e_server.check_local_dsn("postgresql://postgres@db.example.com:5432/raqib")
    e2e_server.check_local_dsn("postgresql://postgres@127.0.0.1:55432/raqib")
    e2e_server.check_local_dsn("postgresql://postgres@localhost:5432/raqib")


# --- local_pg ----------------------------------------------------------------------------------


def test_local_pg_prints_the_recipe_and_exits_2_when_pgserver_is_not_cached(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = local_pg.main(["start"], uv_cache=tmp_path)
    assert code == 2
    err = capsys.readouterr().err
    assert "pginstall" in err and "initdb" in err
    assert not list(tmp_path.iterdir())  # nothing was downloaded or written


def test_local_pg_finds_pginstall_in_the_uv_cache(tmp_path: Path) -> None:
    pginstall = tmp_path / "archive-v0" / "abc" / "Lib" / "site-packages" / "pgserver" / "pginstall"
    (pginstall / "bin").mkdir(parents=True)
    assert local_pg.find_pginstall(tmp_path) == pginstall
    assert local_pg.find_pginstall(tmp_path / "nowhere") is None


# --- Postgres: the same seed through the real roles -------------------------------------------


@pytest.fixture
async def pg_app(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[tuple[FastAPI, str]]:
    """The app on a database prepared by the tool, connected as the real `yawmi_api` role.

    The seed is dated with the real day (as the tool does), so the suite's clock is the real one.
    """
    monkeypatch.setattr("yawmi.events.models.server_now", lambda: datetime.now(UTC))
    admin_dsn = os.environ.get("TEST_DATABASE_URL")
    if not admin_dsn:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not")
        pytest.skip("TEST_DATABASE_URL is not set (database tests run in CI)")
    app_dsn = await e2e_server.prepare_database(admin_dsn)
    pool = await create_pool(app_dsn)
    set_pool(pool)
    try:
        app = e2e_server.build_app(
            Settings(database_url=app_dsn, jwt_secret=SecretStr(SECRET), cookie_secure=False),
            InMemoryDeviceStore(),
        )
        yield app, admin_dsn
    finally:
        set_pool(None)
        await pool.close()
        # the other database tests expect an empty mirror
        conn = await asyncpg.connect(admin_dsn)
        try:
            await e2e_server.clear_mirror(conn)
        finally:
            await conn.close()


async def test_postgres_seed_serves_the_same_overview_and_today(
    pg_app: tuple[FastAPI, str],
) -> None:
    app, _ = pg_app
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        overview = (await c.get("/v1/overview", headers=_device())).json()
        today = (await c.get("/v1/today", headers=_device())).json()
        habits = (await c.get("/v1/habits", headers=_device())).json()
    assert [o["title"] for o in overview["outcomes"]] == list(e2e_server.OUTCOME_TITLES)
    assert len(overview["cards"]) == 3
    due = {h["code"] for h in today["habits_due"]}
    assert set(E2E_CODES) <= due
    listed: Any = habits["habits"] if isinstance(habits, dict) else habits
    assert set(E2E_CODES) <= {h["code"] for h in listed}


async def test_postgres_seed_card_fields_view_and_the_late_milestone(
    pg_app: tuple[FastAPI, str],
) -> None:
    _, admin_dsn = pg_app
    conn = await asyncpg.connect(admin_dsn)
    try:
        rows = await conn.fetch(
            "SELECT target_date, next_step FROM yawmi_ro.notion_card_fields ORDER BY page_id"
        )
        assert len(rows) == 3
        assert all(r["target_date"] and r["next_step"] for r in rows)
        late = await conn.fetchval(
            "SELECT count(*) FROM raqib.notion_milestones WHERE NOT done"
            " AND due_date = (now() AT TIME ZONE 'Asia/Riyadh')::date - 2"
        )
        assert late == 1
        assert await conn.fetchval("SELECT count(*) FROM raqib.cycles") == 21
        assert await conn.fetchval("SELECT count(*) FROM raqib.notion_milestones") == 6
        assert await conn.fetchval("SELECT count(*) FROM raqib.goals") == 12
    finally:
        await conn.close()


async def test_prepare_database_twice_gives_the_same_clean_state(
    pg_app: tuple[FastAPI, str],
) -> None:
    _, admin_dsn = pg_app
    await e2e_server.prepare_database(admin_dsn)
    conn = await asyncpg.connect(admin_dsn)
    try:
        assert await conn.fetchval("SELECT count(*) FROM yawmi.habits") == 14
        assert await conn.fetchval("SELECT count(*) FROM yawmi.habit_logs") == 0
        assert await conn.fetchval("SELECT count(*) FROM yawmi.devices") == 0
    finally:
        await conn.close()
