"""The local server of the end-to-end suite (`web/e2e`). A test tool: never deployed.

    python api/tools/e2e_server.py [--port 8000]

On start it resets the local test database (`YAWMI_E2E_DATABASE_URL`, default the database that
`local_pg.py start` creates), applies `tests/fixtures/raqib_stub.sql` and the migrations with a
`yawmi_api` role whose credential is generated for this run, and seeds:

* the ten system habits, and four habits of the suite: one tick habit and one minutes habit for
  each Playwright project (`e2e_tick_desktop`, `e2e_tick_mobile`, `e2e_minutes_desktop`,
  `e2e_minutes_mobile`), so the two projects never share a value;
* a Notion mirror: 12 outcomes titled as in `GOAL-2031.md`, 21 cycles, 6 milestones (one two days
  late) and 3 cards with a target date and a next step.

The app is `create_app()` with the fake insight provider injected into `app.state.insights` and one
extra route, `POST /__e2e/pair-code`, that exists on this app only: outside `/v1`, hidden from the
schema, loopback callers only. It calls the same `issue_pairing_code` that `yawmi-admin pair-code`
does, so the suite can pair a fresh device for every test without a stored session. The route is
defined here, not in `yawmi/routes`: `create_app()`, `openapi.json` and the container image never
contain it. The signing key and the role credential are made at start and written nowhere. The tool
listens on loopback only and refuses a database that is not local.
"""

import argparse
import asyncio
import json
import os
import secrets
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

import asyncpg
from fake_provider import FakeProvider
from fastapi import APIRouter, FastAPI, HTTPException, Request
from pydantic import BaseModel, SecretStr

from yawmi.admin import issue_pairing_code
from yawmi.ai.service import InsightService
from yawmi.ai.store import InMemoryInsightStore
from yawmi.auth.deps import DevicesDep, DeviceStore
from yawmi.db.migrate import migrate
from yawmi.db.seed import load_habits, seed_habits
from yawmi.domain.days import DEFAULT_TZ, day_key
from yawmi.main import create_app
from yawmi.settings import Settings
from yawmi.today.memory import InMemoryTodayReader
from yawmi.today.reader import CardRow, CycleRow, GoalRow, HabitRow, MilestoneRow

LOOPBACK_HOSTS = ("127.0.0.1", "localhost")
DEFAULT_ADMIN_DSN = "postgresql://postgres@localhost:55432/raqib"
ADMIN_DSN_ENV = "YAWMI_E2E_DATABASE_URL"
API_ROLE = "yawmi_api"
STUB_SQL = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "raqib_stub.sql"
PROJECTS = ("desktop", "mobile")

# The twelve outcomes, titled as the headings of `GOAL-2031.md` (O1 to O12). The mirror needs a
# track for each; those words are the suite's own.
OUTCOME_TITLES = (
    "الصحة الجسدية",
    "الصحة النفسية العالية",
    "نظام لا يموت",
    "منصب قيادي براتب عالٍ، وجاهزية VP",
    "أدلة مهنية مقاسة",
    "الشهادات والتعليم (بحلول 2031-06-30)",
    "الإنجليزية (أولوية عالية)",
    "الأمان المالي",
    "ثلاثة مصادر دخل",
    "القيادة والصفات",
    "الحياة الاجتماعية والأسرة والإيمان",
    "الأثر والتعليم",
)
_TRACKS = ("الصحة", "الصحة", "النظام", "المهنة", "المهنة", "التعليم")
_TRACKS += ("التعليم", "المال", "المال", "القيادة", "الحياة", "الأثر")
_END = date(2031, 12, 31)


@dataclass(frozen=True)
class Mirror:
    """The Notion mirror the suite reads: rows for the in-memory reader and for Postgres alike."""

    goals: list[GoalRow]
    cycles: list[dict[str, Any]]
    milestones: list[MilestoneRow]
    cards: list[CardRow]
    card_props: dict[str, dict[str, Any]] = field(default_factory=dict)


def _cycles() -> list[dict[str, Any]]:
    """21 cycles: cycle 1 ends 2026-12-26, then 12 weeks and a review week each."""
    rows: list[dict[str, Any]] = []
    start = date(2026, 10, 31)
    end = date(2026, 12, 26)
    for n in range(1, 22):
        if n > 1:
            start = rows[-1]["review_end"] + timedelta(days=1)
            end = start + timedelta(days=83)
        if n == 21:
            end = _END  # the closing days belong to the last cycle
        rows.append(
            {
                "cycle_no": n,
                "stage_no": 1 + (n - 1) // 4 if n <= 16 else 5,
                "start_date": start,
                "end_date": end,
                "review_start": min(end + timedelta(days=1), _END),
                "review_end": min(end + timedelta(days=7), _END),
                "theme": f"دورة {n}",
                "gate": "none",
            }
        )
    return rows


def _card_fields(target: str, next_step: str) -> dict[str, Any]:
    """The two keys of the card props that `yawmi_ro.notion_card_fields` exposes."""
    return {"المستهدف": {"start": target}, "الخطوة التالية": next_step}


def mirror(today: date) -> Mirror:
    """12 outcomes, 21 cycles, 6 milestones (one two days late) and 3 cards for `today`."""
    goals = [
        GoalRow(
            code=f"O{n}",
            title=title,
            target_date=date(2031, 6, 30) if n == 6 else _END,
            status="active",
            track=_TRACKS[n - 1],
        )
        for n, title in enumerate(OUTCOME_TITLES, start=1)
    ]
    cards = [
        CardRow("e2e-card-1", "بطاقة الصحة", "🔄 قيد التنفيذ", ("O1",)),
        CardRow("e2e-card-2", "بطاقة الإنجليزية", "📋 مخطط", ("O7",)),
        CardRow("e2e-card-3", "بطاقة النظام", "🔄 قيد التنفيذ", ("O3",)),
    ]
    card_props = {
        "e2e-card-1": _card_fields("2026-12-26", "قياس الأساس"),
        "e2e-card-2": _card_fields("2027-03-27", "اختبار تحديد"),
        "e2e-card-3": _card_fields("2026-12-26", "مراجعة النسخ"),
    }

    def milestone(
        n: int, title: str, outcome: str, cycle: int, due: date, done: bool, card: str
    ) -> MilestoneRow:
        return MilestoneRow(f"e2e-ms-{n}", title, outcome, cycle, due, done, (card,))

    day = timedelta(days=1)
    milestones = [
        milestone(1, "قياس خط الأساس", "O1", 1, today - 2 * day, False, "e2e-card-1"),
        milestone(2, "إعداد جدول التمرين", "O1", 1, today - 5 * day, True, "e2e-card-1"),
        milestone(3, "اختبار تحديد المستوى", "O7", 1, today + 20 * day, False, "e2e-card-2"),
        milestone(4, "خطة المفردات", "O7", 1, today - 9 * day, True, "e2e-card-2"),
        milestone(5, "نسخة احتياطية أولى", "O3", 1, today + 30 * day, False, "e2e-card-3"),
        milestone(6, "مراجعة الأنظمة", "O3", 2, date(2027, 2, 1), False, "e2e-card-3"),
    ]
    return Mirror(goals, _cycles(), milestones, cards, card_props)


def _habit_dict(code: str, title: str, kind: str, unit: str | None, target: int) -> dict[str, Any]:
    return {
        "code": code,
        "title_ar": title,
        "goal_ref": None,
        "outcome": None,
        "ac_ref": None,
        "kind": kind,
        "unit": unit,
        "target_per_period": target,
        "period": "day",
        "schedule_kind": "every_day",
        "weekday_mask": None,
        "every_n": None,
        "anchor_day": None,
        "anchor": "free",
        "end_day": None,
        "system": False,
        "created_by": "user",
        "active": True,
    }


def e2e_habits() -> list[dict[str, Any]]:
    """Per project: a tick habit (a daily yes or no) and a minutes habit (a daily duration)."""
    out: list[dict[str, Any]] = []
    for project in PROJECTS:
        label = "الحاسوب" if project == "desktop" else "الجوال"
        out.append(
            _habit_dict(f"e2e_tick_{project}", f"تأشير تجريبي ({label})", "boolean", None, 1)
        )
        title = f"دقائق تجريبية ({label})"
        out.append(_habit_dict(f"e2e_minutes_{project}", title, "duration", "min", 180))
    return out


def _habit_row(habit: dict[str, Any], today: date) -> HabitRow:
    return HabitRow(
        code=habit["code"],
        title_ar=habit["title_ar"],
        kind=habit["kind"],
        unit=habit["unit"],
        target_per_period=Decimal(habit["target_per_period"]),
        period=habit["period"],
        schedule_kind=habit["schedule_kind"],
        weekday_mask=habit["weekday_mask"],
        every_n=habit["every_n"],
        anchor_day=habit["anchor_day"],
        start_day=today,
        end_day=None,
        goal_ref=habit["goal_ref"],
        outcome=habit["outcome"],
        anchor=habit["anchor"],
    )


# --- the pair-code route (this app only) -------------------------------------------------------


class PairCode(BaseModel):
    code: str


e2e_router = APIRouter(include_in_schema=False)

_LOOPBACK_CLIENTS = frozenset({"127.0.0.1", "::1", "localhost"})


@e2e_router.post("/__e2e/pair-code")
async def pair_code(request: Request, devices: DevicesDep) -> PairCode:
    """A fresh one-time web pairing code, for callers on this machine only."""
    client = request.client
    if client is None or client.host not in _LOOPBACK_CLIENTS:
        raise HTTPException(status_code=403)
    return PairCode(code=await issue_pairing_code(devices, "web"))


def build_app(settings: Settings, devices: DeviceStore | None = None) -> FastAPI:
    """`create_app()` plus the fake provider and the pair-code route. With `devices` the app is
    in memory (tests); without, it opens the Postgres pool in its lifespan."""
    app = create_app(settings=settings, devices=devices)
    app.state.insights = InsightService(FakeProvider(), settings)
    app.include_router(e2e_router)
    return app


# --- seeding -----------------------------------------------------------------------------------


def seed_memory(app: FastAPI, today: date) -> None:
    """Fill an in-memory app: the habits and the mirror behind `/v1/today` and `/v1/overview`."""
    data = mirror(today)
    habits = [*load_habits(), *e2e_habits()]
    app.state.today = InMemoryTodayReader(
        habits=[_habit_row(h, today) for h in habits],
        cycle_rows=[
            CycleRow(c["cycle_no"], c["start_date"], c["end_date"], c["review_end"])
            for c in data.cycles
        ],
        milestone_rows=list(data.milestones),
        goal_rows=list(data.goals),
        card_rows=list(data.cards),
    )
    app.state.insights_store = InMemoryInsightStore()


_HABIT_COLUMNS = (
    *("code", "title_ar", "goal_ref", "outcome", "ac_ref", "kind", "unit", "target_per_period"),
    *("period", "schedule_kind", "weekday_mask", "every_n", "anchor_day", "anchor", "start_day"),
    *("end_day", "system", "created_by", "active"),
)
_CYCLE_COLUMNS = (
    *("cycle_no", "stage_no", "start_date", "end_date", "review_start", "review_end", "theme"),
    "gate",
)


async def seed_postgres(conn: asyncpg.Connection, today: date) -> None:
    """Write the habits and the mirror as the admin role (the API role cannot write the mirror)."""
    await seed_habits(conn)
    marks = ", ".join(f"${i}" for i in range(1, len(_HABIT_COLUMNS) + 1))
    insert = f"INSERT INTO yawmi.habits ({', '.join(_HABIT_COLUMNS)}) VALUES ({marks})"
    for habit in e2e_habits():
        await conn.execute(
            insert, *(today if c == "start_day" else habit[c] for c in _HABIT_COLUMNS)
        )

    data = mirror(today)
    await conn.executemany(
        "INSERT INTO raqib.goals (code, title, track, target_date, acceptance, status)"
        " VALUES ($1, $2, $3, $4, $5, $6)",
        [(g.code, g.title, g.track, g.target_date, "نعم أو لا", g.status) for g in data.goals],
    )
    cycle_marks = ", ".join(f"${i}" for i in range(1, len(_CYCLE_COLUMNS) + 1))
    await conn.executemany(
        f"INSERT INTO raqib.cycles ({', '.join(_CYCLE_COLUMNS)}) VALUES ({cycle_marks})",
        [tuple(c[k] for k in _CYCLE_COLUMNS) for c in data.cycles],
    )
    await conn.executemany(
        "INSERT INTO raqib.notion_milestones"
        " (page_id, title, outcome_code, card_page_ids, cycle_no, due_date, done)"
        " VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)",
        [
            (
                m.page_id,
                m.title,
                m.outcome_code,
                json.dumps(list(m.card_page_ids)),
                m.cycle_no,
                m.due_date,
                m.done,
            )
            for m in data.milestones
        ],
    )
    await conn.executemany(
        "INSERT INTO raqib.notion_cards (page_id, title, status, outcome_codes, props)"
        " VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)",
        [
            (
                c.page_id,
                c.title,
                c.status,
                json.dumps(list(c.outcome_codes)),
                json.dumps(data.card_props[c.page_id], ensure_ascii=False),
            )
            for c in data.cards
        ],
    )


def riyadh_today() -> date:
    return day_key(datetime.now(UTC), DEFAULT_TZ)


def api_role_dsn(admin_dsn: str, role_secret: str) -> str:
    """The admin DSN with the API role (and its generated credential) in place of the admin user."""
    parts = urlsplit(admin_dsn)
    host = parts.hostname or "localhost"
    port = f":{parts.port}" if parts.port else ""
    userinfo = quote(API_ROLE, safe="") + ":" + quote(role_secret, safe="")
    return urlunsplit(("postgresql", f"{userinfo}@{host}{port}", parts.path, "", ""))


async def clear_mirror(conn: asyncpg.Connection) -> None:
    """Empty the mirror tables the seed fills (and the KPI tables that reference the goals)."""
    tables = ("goals", "cycles", "notion_milestones", "notion_cards")
    await conn.execute(
        f"TRUNCATE {', '.join('raqib.' + t for t in tables)} RESTART IDENTITY CASCADE"
    )


async def prepare_database(admin_dsn: str) -> str:
    """Reset the local test database to the seeded state; return the DSN of the `yawmi_api` role.

    Applies the mirror stub and the migrations (the role credential is generated here and only
    lives in the returned DSN), then the seed. Calling it again resets to the same state.
    """
    check_local_dsn(admin_dsn)
    conn = await asyncpg.connect(admin_dsn)
    try:
        await conn.execute(STUB_SQL.read_text(encoding="utf-8"))
        await conn.execute("DROP SCHEMA IF EXISTS yawmi CASCADE")
        await conn.execute("DROP SCHEMA IF EXISTS yawmi_ro CASCADE")
        if await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", API_ROLE):
            await conn.execute(f"DROP OWNED BY {API_ROLE}")
            await conn.execute(f"DROP ROLE {API_ROLE}")
        await clear_mirror(conn)
    finally:
        await conn.close()
    role_secret = secrets.token_hex(16)
    await migrate(admin_dsn, {"yawmi_api_pw": role_secret})
    conn = await asyncpg.connect(admin_dsn)
    try:
        await seed_postgres(conn, riyadh_today())
    finally:
        await conn.close()
    return api_role_dsn(admin_dsn, role_secret)


# --- command line ------------------------------------------------------------------------------


def check_local_dsn(dsn: str) -> None:
    """Exit unless the database is on this machine: the tool resets whatever it connects to."""
    if urlsplit(dsn).hostname not in (*LOOPBACK_HOSTS, "::1"):
        raise SystemExit("the e2e server resets its database: it must be on this machine")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="e2e_server", description="Local server for web/e2e")
    parser.add_argument("--host", choices=LOOPBACK_HOSTS, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    import uvicorn

    args = parse_args(argv)
    admin_dsn = os.environ.get(ADMIN_DSN_ENV, DEFAULT_ADMIN_DSN)
    check_local_dsn(admin_dsn)
    dsn = asyncio.run(prepare_database(admin_dsn))
    settings = Settings(
        database_url=dsn,
        jwt_secret=SecretStr(secrets.token_urlsafe(48)),
        cookie_secure=False,  # the suite runs on http://localhost
    )
    uvicorn.run(build_app(settings), host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
