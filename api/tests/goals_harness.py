"""One backend for the goals tests: memory objects or Postgres rows behind the same calls.

`GoalsBackend` builds what a test needs (outcomes, milestones, cards, KPIs, habits, logs, tasks,
indicators) and hands the app the stores to read them back. The Postgres backend writes real
rows of the raqib stub and the yawmi schema, tracks what it wrote and removes it afterwards; the
habits it did not create (the seed) are paused, so a test counts only its own, and put back.
"""

import json
import os
from collections.abc import AsyncIterator
from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import pytest
from fastapi import FastAPI

from yawmi.db.pool import create_pool, set_pool
from yawmi.events.project import GoalTaskMark
from yawmi.events.store import _MARK_GOAL_TASK as MARK_GOAL_TASK
from yawmi.events.store import goal_task_mark_args
from yawmi.goals.edits_memory import InMemoryEditStore
from yawmi.goals.edits_store import AsyncpgEditStore
from yawmi.goals.memory import InMemoryGoalsReader, InMemoryGoalTaskStore
from yawmi.goals.reader import (
    AsyncpgGoalsReader,
    CardFieldsRow,
    CardFullRow,
    CycleFullRow,
    KpiRow,
    MilestoneFullRow,
    OutcomeRow,
    ReadingRow,
    card_target_date,
)
from yawmi.goals.service import GoalSources
from yawmi.goals.tasks_store import AsyncpgGoalTaskStore
from yawmi.indicators.memory import InMemoryIndicatorStore
from yawmi.indicators.models import IndicatorIO
from yawmi.indicators.store import AsyncpgIndicatorStore
from yawmi.today.memory import InMemoryTodayReader
from yawmi.today.reader import AsyncpgTodayReader, HabitRow, LogRow

PREFIX = "t13_"
IN_CI = bool(os.environ.get("CI"))
MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "migrations"
STUB_SQL = Path(__file__).parent / "fixtures" / "raqib_stub.sql"
KPI_CODES = [
    "workshops_count",
    "books_done",
    "steps_avg",
    "walks_week",
    "strength_sessions",
    "who5_raw",
]
OUTCOMES = [f"O{n}" for n in range(1, 13)]
LONG_AGO = datetime(2026, 1, 1, tzinfo=UTC)


async def open_goals_pool() -> asyncpg.Pool:
    """A pool on the test database with the raqib stub and migrations 0001 to 0003 in place."""
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        if IN_CI:
            pytest.fail("CI is set but TEST_DATABASE_URL is not: the database tests must run")
        pytest.skip("TEST_DATABASE_URL is not set (the Postgres tests run in CI)")
    pool = await create_pool(url)
    await ensure_schema(pool)
    return pool


async def ensure_schema(pool: asyncpg.Pool) -> None:
    """The raqib stub and migrations 0001 to 0003, applied only where missing."""
    await pool.execute(STUB_SQL.read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.events') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0001_yawmi_schema.sql").read_text(encoding="utf-8"))
    if not await pool.fetchval("SELECT to_regclass('yawmi.journal_entries') IS NOT NULL"):
        await pool.execute((MIGRATIONS / "0002_yawmi_role.sql").read_text(encoding="utf-8"))
        await pool.execute((MIGRATIONS / "0003_yawmi_web.sql").read_text(encoding="utf-8"))


def habit_row(code: str, **extra: Any) -> HabitRow:
    return HabitRow(
        code=PREFIX + code,
        title_ar=extra.get("title", "عادة " + code),
        kind=extra.get("kind", "boolean"),
        unit=extra.get("unit"),
        target_per_period=Decimal(str(extra.get("target", 1))),
        period=extra.get("period", "day"),
        schedule_kind=extra.get("schedule_kind", "every_day"),
        weekday_mask=extra.get("weekday_mask"),
        every_n=None,
        anchor_day=None,
        start_day=extra.get("start", date(2026, 10, 31)),
        end_day=extra.get("end"),
        goal_ref=extra.get("goal_ref"),
        outcome=extra.get("outcome"),
        anchor="free",
        polarity=extra.get("polarity", "build"),
    )


class GoalsBackend:
    """Common calls; `memory` or Postgres by the subclass."""

    today: Any
    goals: Any
    tasks: Any
    indicators: Any
    edits: Any

    def sources(self) -> GoalSources:
        return GoalSources(
            goals=self.goals,
            today=self.today,
            tasks=self.tasks,
            indicators=self.indicators,
            edits=self.edits,
        )

    def install(self, app: FastAPI) -> None:  # memory backend overrides
        pass

    async def pause_other_habits(self) -> None:
        pass

    async def setup(self) -> None:
        pass

    async def cleanup(self) -> None:
        pass

    async def outcome(self, code: str, **kw: Any) -> None:
        raise NotImplementedError

    async def milestone(self, key: str, outcome: str | None, **kw: Any) -> str:
        raise NotImplementedError

    async def card(self, key: str, **kw: Any) -> str:
        raise NotImplementedError

    async def sync(self, kind: str, page_id: str, **values: Any) -> None:
        """The mirror syncs a page: new values (`edited` is `notion_edited_at`)."""
        raise NotImplementedError

    async def cycle(self, no: int, start: date, end: date, review_end: date) -> None:
        raise NotImplementedError

    async def kpi(self, code: str, goal_code: str | None, **kw: Any) -> None:
        raise NotImplementedError

    async def reading(self, code: str, day: date, value: float) -> None:
        raise NotImplementedError

    async def habit(self, code: str, **kw: Any) -> str:
        raise NotImplementedError

    async def log(self, code: str, day: date, value: float | None, status: str = "done") -> None:
        raise NotImplementedError

    async def put_indicator(self, **kw: Any) -> None:
        values: dict[str, Any] = {
            "subject_kind": "goal",
            "source": "tasks",
            "measure": "completion",
            "period": "all",
            "display": "ring",
        }
        await self.indicators.put(IndicatorIO(**{**values, **kw}))

    async def mark_from_event(self, task_id: UUID, done: bool, logged_at: datetime) -> None:
        """A `goal_task_set` event reaches the task, by the rule of the events projection."""
        raise NotImplementedError

    async def task(self, goal_ref: str, title: str, *, done: bool = False) -> str:
        created = await self.tasks.create(goal_ref, title, None, LONG_AGO)
        if done:
            await self.tasks.patch(created.id, {"done": True}, LONG_AGO)
        return str(created.id)


class MemoryGoals(GoalsBackend):
    kind = "memory"

    def __init__(self) -> None:
        self.today = InMemoryTodayReader()
        self.goals = InMemoryGoalsReader()
        self.tasks = InMemoryGoalTaskStore()
        self.indicators = InMemoryIndicatorStore()
        self.edits = InMemoryEditStore()

    def install(self, app: FastAPI) -> None:
        app.state.today = self.today
        app.state.goals = self.goals
        app.state.goal_tasks = self.tasks
        app.state.indicators = self.indicators
        app.state.goal_edits = self.edits

    async def sync(self, kind: str, page_id: str, **values: Any) -> None:
        rows = self.goals.milestone_rows if kind == "milestone" else self.goals.card_rows
        changes = {("notion_edited_at" if k == "edited" else k): v for k, v in values.items()}
        for i, row in enumerate(rows):
            if row.page_id == page_id:
                rows[i] = replace(row, **changes)

    async def mark_from_event(self, task_id: UUID, done: bool, logged_at: datetime) -> None:
        await self.tasks.mark_from_event(task_id, done, logged_at)

    async def outcome(self, code: str, **kw: Any) -> None:
        self.goals.outcome_rows.append(
            OutcomeRow(
                code=code,
                title=kw.get("title", "مخرج " + code),
                track=kw.get("track", "المسار"),
                target_date=kw.get("target", date(2031, 12, 31)),
                acceptance=kw.get("acceptance", "معيار " + code),
                status=kw.get("status", "active"),
            )
        )

    async def milestone(self, key: str, outcome: str | None, **kw: Any) -> str:
        page_id = PREFIX + key
        self.goals.milestone_rows.append(
            MilestoneFullRow(
                page_id=page_id,
                title=kw.get("title", "محطة " + key),
                outcome_code=outcome,
                card_page_ids=tuple(PREFIX + c for c in kw.get("cards", ())),
                cycle_no=kw.get("cycle"),
                due_date=kw.get("due"),
                done=kw.get("done", False),
                criterion=kw.get("criterion"),
                evidence=kw.get("evidence"),
                notion_edited_at=kw.get("edited"),
            )
        )
        return page_id

    async def card(self, key: str, **kw: Any) -> str:
        page_id = PREFIX + key
        self.goals.card_rows.append(
            CardFullRow(
                page_id=page_id,
                title=kw.get("title", "بطاقة " + key),
                status=kw.get("status"),
                outcome_codes=tuple(kw.get("outcomes", ())),
                notion_edited_at=kw.get("edited"),
            )
        )
        props = kw.get("props") or {}
        raw = props.get("المستهدف")
        text = raw.get("start") if isinstance(raw, dict) else raw
        nxt = props.get("الخطوة التالية")
        self.goals.card_field_rows.append(
            CardFieldsRow(
                page_id=page_id,
                target_date=card_target_date(text),
                next_step=nxt if isinstance(nxt, str) else None,
            )
        )
        return page_id

    async def cycle(self, no: int, start: date, end: date, review_end: date) -> None:
        self.goals.cycle_rows.append(
            CycleFullRow(no, 1, start, end, end, review_end, "موضوع", "بوابة")
        )

    async def kpi(self, code: str, goal_code: str | None, **kw: Any) -> None:
        self.goals.kpi_rows.append(
            KpiRow(
                code=code,
                name=kw.get("name", "مؤشر " + code),
                unit=kw.get("unit", "ورشة"),
                direction=kw.get("direction", "up"),
                target=Decimal(str(kw["target"])) if kw.get("target") is not None else None,
                frequency=kw.get("frequency", "cycle"),
                goal_code=goal_code,
            )
        )

    async def reading(self, code: str, day: date, value: float) -> None:
        self.goals.reading_rows.append(ReadingRow(code, day, Decimal(str(value))))

    async def habit(self, code: str, **kw: Any) -> str:
        row = habit_row(code, **kw)
        self.today.habits.append(row)
        return row.code

    async def log(self, code: str, day: date, value: float | None, status: str = "done") -> None:
        self.today.logs.append(
            LogRow(PREFIX + code, day, None if value is None else Decimal(str(value)), status)
        )


class PostgresGoals(GoalsBackend):
    kind = "postgres"

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.today = AsyncpgTodayReader(pool)
        self.goals = AsyncpgGoalsReader(pool)
        self.tasks = AsyncpgGoalTaskStore(pool)
        self.indicators = AsyncpgIndicatorStore(pool)
        self.edits = AsyncpgEditStore(pool)
        self.paused: list[str] = []
        self.cycles: list[int] = []

    async def setup(self) -> None:
        await self.cleanup()

    async def pause_other_habits(self) -> None:
        rows = await self.pool.fetch(
            "UPDATE yawmi.habits SET active = false WHERE code NOT LIKE $1 AND active"
            " RETURNING code",
            PREFIX + "%",
        )
        self.paused.extend(r["code"] for r in rows)

    async def cleanup(self) -> None:
        like = PREFIX + "%"
        pool = self.pool
        await pool.execute("DELETE FROM yawmi.habit_logs WHERE habit_code LIKE $1", like)
        await pool.execute("DELETE FROM yawmi.habits WHERE code LIKE $1", like)
        for code in self.paused:
            await pool.execute("UPDATE yawmi.habits SET active = true WHERE code = $1", code)
        self.paused.clear()
        await pool.execute("DELETE FROM raqib.notion_milestones WHERE page_id LIKE $1", like)
        await pool.execute("DELETE FROM raqib.notion_cards WHERE page_id LIKE $1", like)
        await pool.execute(
            "DELETE FROM raqib.kpi_readings WHERE kpi_code = ANY($1) OR kpi_code LIKE $2",
            KPI_CODES,
            like,
        )
        await pool.execute(
            "DELETE FROM raqib.kpis WHERE code = ANY($1) OR code LIKE $2", KPI_CODES, like
        )
        await pool.execute(
            "DELETE FROM raqib.cycles WHERE cycle_no = ANY($1)", [1, 2, 3, *self.cycles]
        )
        await pool.execute("DELETE FROM raqib.goals WHERE code = ANY($1)", [*OUTCOMES, "weight"])
        await pool.execute("DELETE FROM yawmi.indicators WHERE subject_kind = 'goal'")
        await pool.execute(
            "DELETE FROM yawmi.goal_tasks WHERE goal_ref LIKE $1 OR goal_ref ~ '^O[0-9]+$'", like
        )
        await pool.execute("DELETE FROM yawmi.notice_sends")
        await pool.execute("DELETE FROM yawmi.goal_edits WHERE page_id LIKE $1", like)

    async def mark_from_event(self, task_id: UUID, done: bool, logged_at: datetime) -> None:
        mark = GoalTaskMark(event_id=uuid4(), task_id=task_id, done=done, logged_at=logged_at)
        await self.pool.execute(MARK_GOAL_TASK, *goal_task_mark_args(mark))

    async def outcome(self, code: str, **kw: Any) -> None:
        await self.pool.execute(
            "INSERT INTO raqib.goals (code, title, track, target_date, acceptance, status)"
            " VALUES ($1, $2, $3, $4, $5, $6)",
            code,
            kw.get("title", "مخرج " + code),
            kw.get("track", "المسار"),
            kw.get("target", date(2031, 12, 31)),
            kw.get("acceptance", "معيار " + code),
            kw.get("status", "active"),
        )

    async def milestone(self, key: str, outcome: str | None, **kw: Any) -> str:
        page_id = PREFIX + key
        await self.pool.execute(
            "INSERT INTO raqib.notion_milestones (page_id, title, outcome_code, card_page_ids,"
            " cycle_no, due_date, done, criterion, evidence, notion_edited_at) VALUES"
            " ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)",
            page_id,
            kw.get("title", "محطة " + key),
            outcome,
            json.dumps([PREFIX + c for c in kw.get("cards", ())]),
            kw.get("cycle"),
            kw.get("due"),
            kw.get("done", False),
            kw.get("criterion"),
            kw.get("evidence"),
            kw.get("edited"),
        )
        return page_id

    async def card(self, key: str, **kw: Any) -> str:
        page_id = PREFIX + key
        await self.pool.execute(
            "INSERT INTO raqib.notion_cards (page_id, title, status, outcome_codes, props,"
            " notion_edited_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)",
            page_id,
            kw.get("title", "بطاقة " + key),
            kw.get("status"),
            json.dumps(list(kw.get("outcomes", ()))),
            json.dumps(kw.get("props") or {}, ensure_ascii=False),
            kw.get("edited"),
        )
        return page_id

    async def sync(self, kind: str, page_id: str, **values: Any) -> None:
        table = "raqib.notion_milestones" if kind == "milestone" else "raqib.notion_cards"
        columns = [("notion_edited_at" if k == "edited" else k) for k in values]
        assigns = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(columns))
        await self.pool.execute(
            f"UPDATE {table} SET {assigns} WHERE page_id = $1", page_id, *values.values()
        )

    async def cycle(self, no: int, start: date, end: date, review_end: date) -> None:
        await self.pool.execute(
            "INSERT INTO raqib.cycles (cycle_no, stage_no, start_date, end_date, review_start,"
            " review_end, theme, gate) VALUES ($1, 1, $2, $3, $3, $4, 'موضوع', 'بوابة')",
            no,
            start,
            end,
            review_end,
        )
        self.cycles.append(no)

    async def kpi(self, code: str, goal_code: str | None, **kw: Any) -> None:
        await self.pool.execute(
            "INSERT INTO raqib.kpis (code, name, unit, direction, target, frequency, goal_code)"
            " VALUES ($1, $2, $3, $4, $5, $6, $7)",
            code,
            kw.get("name", "مؤشر " + code),
            kw.get("unit", "ورشة"),
            kw.get("direction", "up"),
            Decimal(str(kw["target"])) if kw.get("target") is not None else None,
            kw.get("frequency", "cycle"),
            goal_code,
        )

    async def reading(self, code: str, day: date, value: float) -> None:
        await self.pool.execute(
            "INSERT INTO raqib.kpi_readings (kpi_code, reading_date, value, source)"
            " VALUES ($1, $2, $3, $4)",
            code,
            day,
            Decimal(str(value)),
            f"src-{uuid4().hex[:6]}",
        )

    async def habit(self, code: str, **kw: Any) -> str:
        row = habit_row(code, **kw)
        await self.pool.execute(
            "INSERT INTO yawmi.habits (code, title_ar, kind, unit, target_per_period, period,"
            " schedule_kind, weekday_mask, every_n, anchor_day, start_day, end_day, goal_ref,"
            " outcome, anchor, created_by, polarity) VALUES"
            " ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'user', $16)",
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
            row.outcome,
            row.anchor,
            row.polarity,
        )
        return row.code

    async def log(self, code: str, day: date, value: float | None, status: str = "done") -> None:
        await self.pool.execute(
            "INSERT INTO yawmi.habit_logs (id, habit_code, day, value, status, source, logged_at)"
            " VALUES ($1, $2, $3, $4, $5, $6, now())",
            uuid4(),
            PREFIX + code,
            day,
            None if value is None else Decimal(str(value)),
            status,
            f"src-{uuid4().hex[:6]}",
        )


@pytest.fixture(params=["memory", "postgres"])
async def goals_backend(request: pytest.FixtureRequest) -> AsyncIterator[GoalsBackend]:
    if request.param == "memory":
        yield MemoryGoals()
        return
    pool = await open_goals_pool()
    pg = PostgresGoals(pool)
    await pg.setup()
    set_pool(pool)
    try:
        yield pg
    finally:
        set_pool(None)
        await pg.cleanup()
        await pool.close()
