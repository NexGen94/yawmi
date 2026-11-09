"""Tests for the yawmi schema migrations and the ``yawmi_api`` role.

Two groups:

* Plain tests (no database): the migration runner's file handling and static
  guards on the SQL files themselves. These run everywhere.
* Database tests: need a real Postgres with a ``raqib`` database and a user allowed
  to create schemas and roles (superuser in CI). They are skipped unless
  ``TEST_DATABASE_URL`` is set; the real run happens in GitHub Actions
  (``.github/workflows/api-tests.yml``).
"""

import json
import os
import re
import secrets
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

import asyncpg
import pytest
from asyncpg import exceptions as pgerr

from yawmi.db.migrate import MIGRATIONS_DIR, MigrationError, migrate, strip_transaction

DSN = os.environ.get("TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL is not set (CI-only tests)")

STUB_SQL = Path(__file__).parent / "fixtures" / "raqib_stub.sql"
EXPECTED_FILES = ["0001_yawmi_schema.sql", "0002_yawmi_role.sql"]
YAWMI_TABLES = [
    "ai_insights",
    "breath_sessions",
    "daily_metrics",
    "devices",
    "events",
    "focus_sessions",
    "habit_logs",
    "habit_reminders",
    "habits",
    "pairing_codes",
    "push_subscriptions",
    "reminder_sends",
    "sync_cursor",
]
DELETABLE = {"pairing_codes", "push_subscriptions"}
RAQIB_READABLE = [
    "notion_milestones",
    "notion_cards",
    "goals",
    "cycles",
    "kpis",
    "kpi_readings",
    "v_journal_daily",
]
NOW = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Plain tests: runner file handling and static guards (no database)
# ---------------------------------------------------------------------------


def test_strip_transaction_removes_the_wrapper_only():
    sql = "-- header COMMIT;\nBEGIN;\nCREATE TABLE a (x int);\nCOMMIT;\n"
    out = strip_transaction("0001_x.sql", sql)
    assert "BEGIN;" not in out
    assert "\nCOMMIT;" not in out
    assert "-- header COMMIT;" in out
    assert "CREATE TABLE a (x int);" in out


def test_strip_transaction_accepts_unwrapped_files():
    sql = "CREATE TABLE a (x int);\n"
    assert strip_transaction("0001_x.sql", sql) == sql


@pytest.mark.parametrize(
    "sql",
    [
        "BEGIN;\nSELECT 1;\n",  # BEGIN without COMMIT
        "SELECT 1;\nCOMMIT;\n",  # COMMIT without BEGIN
        "COMMIT;\nSELECT 1;\nBEGIN;\n",  # COMMIT before BEGIN
        "BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;\n",  # two transactions
        "BEGIN;\nSELECT 1;\nROLLBACK;\nCOMMIT;\n",  # stray transaction control
        "BEGIN;\nSELECT 1;\nSTART TRANSACTION;\nCOMMIT;\n",
    ],
)
def test_strip_transaction_rejects_unsafe_transaction_control(sql):
    with pytest.raises(MigrationError):
        strip_transaction("0001_x.sql", sql)


async def test_migrate_rejects_bad_param_names_before_connecting():
    # The DSN is unreachable on purpose: validation must fail first.
    with pytest.raises(MigrationError):
        await migrate("postgresql://nobody@localhost:1/none", {"Bad Name": "x"})


async def test_migrate_rejects_bad_file_names(tmp_path: Path):
    (tmp_path / "0001_ok.sql").write_text("SELECT 1;\n")
    (tmp_path / "setup.sql").write_text("SELECT 1;\n")
    with pytest.raises(MigrationError):
        await migrate("postgresql://nobody@localhost:1/none", migrations_dir=tmp_path)


async def test_migrate_rejects_duplicate_numbers(tmp_path: Path):
    (tmp_path / "0001_a.sql").write_text("SELECT 1;\n")
    (tmp_path / "0001_b.sql").write_text("SELECT 1;\n")
    with pytest.raises(MigrationError):
        await migrate("postgresql://nobody@localhost:1/none", migrations_dir=tmp_path)


def test_migration_files_are_the_expected_pair_in_order():
    assert sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql")) == EXPECTED_FILES


@pytest.mark.parametrize("name", EXPECTED_FILES)
def test_migration_files_are_lf_and_transaction_wrapped(name: str):
    raw = (MIGRATIONS_DIR / name).read_bytes()
    assert b"\r" not in raw, "migrations must use LF line endings"
    text = raw.decode("utf-8")
    strip_transaction(name, text)  # raises if the BEGIN/COMMIT wrapper is malformed
    assert re.search(r"^BEGIN;$", text, re.MULTILINE)
    assert re.search(r"^COMMIT;$", text, re.MULTILINE)


def test_no_password_literal_in_any_migration():
    for path in MIGRATIONS_DIR.glob("*.sql"):
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"PASSWORD\s+'", text, re.IGNORECASE), f"{path.name}: literal password"
        assert not re.search(r"PASSWORD\s+\$", text, re.IGNORECASE), (
            f"{path.name}: dollar-quoted password"
        )


def test_role_migration_documents_the_password_mechanism():
    header = (MIGRATIONS_DIR / "0002_yawmi_role.sql").read_text(encoding="utf-8").split("BEGIN;")[0]
    assert "/run/yawmi/yawmi_api_pw" in header
    assert "yawmi_migrate.yawmi_api_pw" in header


# ---------------------------------------------------------------------------
# Database fixtures
# ---------------------------------------------------------------------------


async def _reset(conn: asyncpg.Connection) -> None:
    await conn.execute("DROP SCHEMA IF EXISTS yawmi CASCADE")
    if await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = 'yawmi_api'"):
        await conn.execute("DROP OWNED BY yawmi_api")
        await conn.execute("DROP ROLE yawmi_api")


@pytest.fixture
async def conn() -> AsyncIterator[asyncpg.Connection]:
    """Admin connection to a database with the raqib stub applied and yawmi wiped."""
    assert DSN
    c = await asyncpg.connect(DSN)
    try:
        await c.execute(STUB_SQL.read_text(encoding="utf-8"))
        await _reset(c)
        yield c
    finally:
        await c.execute("RESET ROLE")
        await c.close()


@pytest.fixture
def api_pw() -> str:
    # Generated per run so no password literal lives in the repository.
    return secrets.token_hex(16)


@pytest.fixture
async def migrated(conn: asyncpg.Connection, api_pw: str) -> asyncpg.Connection:
    assert DSN
    await migrate(DSN, {"yawmi_api_pw": api_pw})
    return conn


HABIT_DEFAULTS: dict[str, object] = {
    "code": "h1",
    "title_ar": "عادة تجريبية",
    "kind": "boolean",
    "target_per_period": Decimal(1),
    "period": "day",
    "start_day": date(2026, 11, 9),
    "created_by": "user",
}


async def insert_habit(conn: asyncpg.Connection, **overrides: object) -> None:
    row = {**HABIT_DEFAULTS, **overrides}
    cols = ", ".join(row)
    marks = ", ".join(f"${i}" for i in range(1, len(row) + 1))
    await conn.execute(f"INSERT INTO yawmi.habits ({cols}) VALUES ({marks})", *row.values())


async def insert_event(conn: asyncpg.Connection, event_id: uuid.UUID | None = None) -> uuid.UUID:
    event_id = event_id or uuid.uuid4()
    await conn.execute(
        "INSERT INTO yawmi.events (id, type, payload, occurred_at) VALUES ($1, $2, $3, $4)",
        event_id,
        "habit_logged",
        json.dumps({"habit_code": "h1"}),
        NOW,
    )
    return event_id


# ---------------------------------------------------------------------------
# Database tests: the runner
# ---------------------------------------------------------------------------


@needs_db
async def test_migrate_twice_applies_then_does_nothing(conn: asyncpg.Connection, api_pw: str):
    assert DSN
    assert await migrate(DSN, {"yawmi_api_pw": api_pw}) == EXPECTED_FILES
    assert await migrate(DSN, {"yawmi_api_pw": api_pw}) == []
    rows = await conn.fetch("SELECT filename, applied_at FROM yawmi.schema_migrations")
    assert sorted(r["filename"] for r in rows) == EXPECTED_FILES
    assert all(r["applied_at"] is not None for r in rows)


@needs_db
async def test_failed_migration_rolls_back_and_is_not_recorded(
    conn: asyncpg.Connection, tmp_path: Path
):
    assert DSN
    (tmp_path / "0001_ok.sql").write_text("BEGIN;\nCREATE TABLE yawmi.t_ok (x int);\nCOMMIT;\n")
    (tmp_path / "0002_bad.sql").write_text(
        "BEGIN;\nCREATE TABLE yawmi.t_half (x int);\nSELECT 1 / 0;\nCOMMIT;\n"
    )
    with pytest.raises(pgerr.DivisionByZeroError):
        await migrate(DSN, migrations_dir=tmp_path)
    names = await conn.fetch("SELECT filename FROM yawmi.schema_migrations")
    assert [r["filename"] for r in names] == ["0001_ok.sql"]
    assert await conn.fetchval("SELECT to_regclass('yawmi.t_ok')") is not None
    assert await conn.fetchval("SELECT to_regclass('yawmi.t_half')") is None


# ---------------------------------------------------------------------------
# Database tests: schema shape
# ---------------------------------------------------------------------------


@needs_db
async def test_thirteen_tables_exist(migrated: asyncpg.Connection):
    rows = await migrated.fetch(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'yawmi' AND table_type = 'BASE TABLE'"
    )
    names = {r["table_name"] for r in rows}
    assert names == set(YAWMI_TABLES) | {"schema_migrations"}
    assert len(set(YAWMI_TABLES)) == 13


@needs_db
async def test_every_timestamp_is_timestamptz_and_nothing_uses_serial(
    migrated: asyncpg.Connection,
):
    naive = await migrated.fetch(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = 'yawmi' AND data_type = 'timestamp without time zone'"
    )
    assert naive == []
    sequences = await migrated.fetch(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = 'yawmi' AND (column_default LIKE 'nextval%' OR is_identity = 'YES')"
    )
    assert sequences == []


@needs_db
async def test_events_indexes(migrated: asyncpg.Connection):
    defs = [
        r["indexdef"]
        for r in await migrated.fetch(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'yawmi' AND tablename = 'events'"
        )
    ]
    assert any(d.endswith("(occurred_at)") for d in defs), defs
    assert any(d.endswith("(type, occurred_at)") for d in defs), defs


@needs_db
async def test_events_defaults_and_idempotent_insert(migrated: asyncpg.Connection):
    event_id = await insert_event(migrated)
    row = await migrated.fetchrow(
        "SELECT tz, received_at FROM yawmi.events WHERE id = $1", event_id
    )
    assert row is not None
    assert row["tz"] == "Asia/Riyadh"
    assert abs(row["received_at"] - datetime.now(UTC)) < timedelta(minutes=5)
    status = await migrated.execute(
        "INSERT INTO yawmi.events (id, type, payload, occurred_at) VALUES ($1, 'x', '{}', $2) "
        "ON CONFLICT (id) DO NOTHING",
        event_id,
        NOW,
    )
    assert status == "INSERT 0 0"


# ---------------------------------------------------------------------------
# Database tests: constraints
# ---------------------------------------------------------------------------


@needs_db
async def test_habit_log_with_bogus_status_is_rejected(migrated: asyncpg.Connection):
    await insert_habit(migrated)
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.habit_logs (id, habit_code, day, status, source, logged_at) "
            "VALUES ($1, 'h1', $2, 'bogus', 'web', $3)",
            uuid.uuid4(),
            date(2026, 11, 9),
            NOW,
        )


@needs_db
async def test_weekly_habit_cannot_use_weekday_schedule(migrated: asyncpg.Connection):
    with pytest.raises(pgerr.CheckViolationError) as exc:
        await insert_habit(migrated, period="week", schedule_kind="weekdays", weekday_mask=5)
    assert exc.value.constraint_name == "habits_period_schedule_chk"


@needs_db
async def test_every_n_days_requires_anchor_day(migrated: asyncpg.Connection):
    with pytest.raises(pgerr.CheckViolationError) as exc:
        await insert_habit(migrated, schedule_kind="every_n_days", every_n=3)
    assert exc.value.constraint_name == "habits_every_n_anchor_chk"
    await insert_habit(
        migrated, code="h2", schedule_kind="every_n_days", every_n=3, anchor_day=date(2026, 11, 9)
    )


@needs_db
async def test_weekdays_schedule_requires_mask(migrated: asyncpg.Connection):
    with pytest.raises(pgerr.CheckViolationError) as exc:
        await insert_habit(migrated, schedule_kind="weekdays")
    assert exc.value.constraint_name == "habits_weekdays_mask_chk"
    await insert_habit(migrated, code="h2", schedule_kind="weekdays", weekday_mask=0b0011111)


@needs_db
async def test_habit_end_day_cannot_precede_start_day(migrated: asyncpg.Connection):
    with pytest.raises(pgerr.CheckViolationError) as exc:
        await insert_habit(migrated, end_day=date(2026, 11, 8))
    assert exc.value.constraint_name == "habits_end_after_start_chk"
    await insert_habit(migrated, code="h2", end_day=date(2026, 11, 9))


@needs_db
@pytest.mark.parametrize(
    "overrides",
    [
        {"outcome": "O13"},
        {"outcome": "o1"},
        {"kind": "text"},
        {"unit": "week"},
        {"period": "year"},
        {"anchor": "noon"},
        {"created_by": "robot"},
        {"target_per_period": Decimal(0)},
        {"weekday_mask": 0},
        {"weekday_mask": 128},
        {"every_n": 1},
        {"schedule_kind": "sometimes"},
    ],
)
async def test_habit_column_checks(migrated: asyncpg.Connection, overrides: dict[str, object]):
    with pytest.raises(pgerr.CheckViolationError):
        await insert_habit(migrated, **overrides)


@needs_db
async def test_habit_accepts_boundary_values(migrated: asyncpg.Connection):
    await insert_habit(migrated, code="o1", outcome="O1")
    await insert_habit(migrated, code="o12", outcome="O12")
    await insert_habit(migrated, code="m127", schedule_kind="weekdays", weekday_mask=127)
    defaults = await migrated.fetchrow(
        "SELECT schedule_kind, system, active, updated_at FROM yawmi.habits WHERE code = 'o1'"
    )
    assert defaults is not None
    assert defaults["schedule_kind"] == "every_day"
    assert defaults["system"] is False
    assert defaults["active"] is True
    assert defaults["updated_at"] is not None


@needs_db
async def test_device_kind_is_checked(migrated: asyncpg.Connection):
    await migrated.execute(
        "INSERT INTO yawmi.devices (id, name, kind) VALUES ($1, 'phone', 'iphone')", uuid.uuid4()
    )
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.devices (id, name, kind) VALUES ($1, 'tv', 'tv')", uuid.uuid4()
        )


@needs_db
async def test_reminder_defaults_and_foreign_key(migrated: asyncpg.Connection):
    await insert_habit(migrated)
    reminder_id = uuid.uuid4()
    await migrated.execute(
        "INSERT INTO yawmi.habit_reminders (id, habit_code, at_time) VALUES ($1, 'h1', $2)",
        reminder_id,
        time(7, 30),
    )
    row = await migrated.fetchrow(
        "SELECT weekday_mask, active FROM yawmi.habit_reminders WHERE id = $1", reminder_id
    )
    assert row is not None
    assert row["weekday_mask"] == 127
    assert row["active"] is True
    with pytest.raises(pgerr.ForeignKeyViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.habit_reminders (id, habit_code, at_time) VALUES ($1, 'nope', $2)",
            uuid.uuid4(),
            time(7, 30),
        )
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.habit_reminders (id, habit_code, at_time, weekday_mask) "
            "VALUES ($1, 'h1', $2, 0)",
            uuid.uuid4(),
            time(7, 30),
        )


@needs_db
async def test_reminder_is_sent_once_per_day(migrated: asyncpg.Connection):
    await insert_habit(migrated)
    reminder_id = uuid.uuid4()
    await migrated.execute(
        "INSERT INTO yawmi.habit_reminders (id, habit_code, at_time) VALUES ($1, 'h1', $2)",
        reminder_id,
        time(7, 30),
    )
    await migrated.execute(
        "INSERT INTO yawmi.reminder_sends (reminder_id, day) VALUES ($1, $2)",
        reminder_id,
        date(2026, 11, 9),
    )
    with pytest.raises(pgerr.UniqueViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.reminder_sends (reminder_id, day) VALUES ($1, $2)",
            reminder_id,
            date(2026, 11, 9),
        )
    await migrated.execute(
        "INSERT INTO yawmi.reminder_sends (reminder_id, day) VALUES ($1, $2)",
        reminder_id,
        date(2026, 11, 10),
    )


UPSERT = (
    "INSERT INTO yawmi.habit_logs (id, habit_code, day, value, status, source, logged_at) "
    "VALUES ($1, 'h1', $2, $3, 'done', 'web', $4) "
    "ON CONFLICT (habit_code, day, source) DO UPDATE "
    "SET value = excluded.value, logged_at = excluded.logged_at "
    "WHERE excluded.logged_at >= yawmi.habit_logs.logged_at"
)


@needs_db
async def test_habit_log_is_unique_per_habit_day_source_and_latest_write_wins(
    migrated: asyncpg.Connection,
):
    await insert_habit(migrated)
    day = date(2026, 11, 9)
    newer, older = NOW, NOW - timedelta(minutes=5)
    # The newer edit arrives first, the older one afterwards: the newer value must stay.
    await migrated.execute(UPSERT, uuid.uuid4(), day, Decimal(5), newer)
    await migrated.execute(UPSERT, uuid.uuid4(), day, Decimal(1), older)
    rows = await migrated.fetch("SELECT value, logged_at FROM yawmi.habit_logs")
    assert [(r["value"], r["logged_at"]) for r in rows] == [(Decimal(5), newer)]
    # Without ON CONFLICT the same key is a hard error.
    with pytest.raises(pgerr.UniqueViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.habit_logs (id, habit_code, day, status, source, logged_at) "
            "VALUES ($1, 'h1', $2, 'skip', 'web', $3)",
            uuid.uuid4(),
            day,
            NOW,
        )
    # Another source for the same day is a separate row.
    await migrated.execute(
        "INSERT INTO yawmi.habit_logs (id, habit_code, day, status, source, logged_at) "
        "VALUES ($1, 'h1', $2, 'done', 'watch', $3)",
        uuid.uuid4(),
        day,
        NOW,
    )


@needs_db
async def test_habit_log_links_to_event_and_habit(migrated: asyncpg.Connection):
    await insert_habit(migrated)
    event_id = await insert_event(migrated)
    await migrated.execute(
        "INSERT INTO yawmi.habit_logs (id, habit_code, day, status, source, event_id, logged_at) "
        "VALUES ($1, 'h1', $2, 'vacation', 'web', $3, $4)",
        uuid.uuid4(),
        date(2026, 11, 9),
        event_id,
        NOW,
    )
    with pytest.raises(pgerr.ForeignKeyViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.habit_logs (id, habit_code, day, status, source, logged_at) "
            "VALUES ($1, 'missing', $2, 'done', 'web', $3)",
            uuid.uuid4(),
            date(2026, 11, 9),
            NOW,
        )


@needs_db
async def test_daily_metrics_score_ranges(migrated: asyncpg.Connection):
    day = date(2026, 11, 9)
    await migrated.execute(
        "INSERT INTO yawmi.daily_metrics (day, hrv_ms, rhr_bpm, sleep_minutes, steps, active_kcal, "
        "recovery_score, strain_score, sleep_score, stress_score) "
        "VALUES ($1, 48.5, 55, 430, 8123, 512.5, 100, 21.0, 0, 50)",
        day,
    )
    row = await migrated.fetchrow("SELECT data_quality, computed_at FROM yawmi.daily_metrics")
    assert row is not None
    assert json.loads(row["data_quality"]) == {}
    assert row["computed_at"] is not None
    out_of_range: list[tuple[str, int | Decimal]] = [
        ("recovery_score", 101),
        ("strain_score", Decimal(22)),
        ("sleep_score", -1),
        ("stress_score", 101),
    ]
    for column, bad in out_of_range:
        with pytest.raises(pgerr.CheckViolationError):
            await migrated.execute(
                f"INSERT INTO yawmi.daily_metrics (day, {column}) VALUES ($1, $2)",
                day + timedelta(days=1),
                bad,
            )


@needs_db
async def test_ai_insight_keeps_two_lines_at_most(migrated: asyncpg.Connection):
    insert = (
        "INSERT INTO yawmi.ai_insights (id, kind, day, provider, model, request_hash, lines) "
        "VALUES ($1, 'day_close', $2, 'anthropic', 'claude-haiku-5-5', 'abc', $3)"
    )
    await migrated.execute(insert, uuid.uuid4(), date(2026, 11, 9), json.dumps(["أ", "ب"]))
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(insert, uuid.uuid4(), date(2026, 11, 9), json.dumps(["أ", "ب", "ج"]))


@needs_db
async def test_session_and_cursor_tables_accept_rows(migrated: asyncpg.Connection):
    device_id = uuid.uuid4()
    await migrated.execute(
        "INSERT INTO yawmi.devices (id, name, kind) VALUES ($1, 'web', 'web')", device_id
    )
    await migrated.execute(
        "INSERT INTO yawmi.focus_sessions (id, device_id, day, started_at, ended_at, focus_rating) "
        "VALUES ($1, $2, $3, $4, $5, 4)",
        uuid.uuid4(),
        device_id,
        date(2026, 11, 9),
        NOW,
        NOW + timedelta(minutes=25),
    )
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.focus_sessions (id, day, started_at, ended_at) "
            "VALUES ($1, $2, $3, $4)",
            uuid.uuid4(),
            date(2026, 11, 9),
            NOW,
            NOW - timedelta(minutes=1),
        )
    await migrated.execute(
        "INSERT INTO yawmi.breath_sessions (id, device_id, day, started_at, pattern, "
        "duration_seconds) VALUES ($1, $2, $3, $4, 'slow', 60)",
        uuid.uuid4(),
        device_id,
        date(2026, 11, 9),
        NOW,
    )
    await migrated.execute(
        "INSERT INTO yawmi.sync_cursor (device_id, stream, cursor_at) VALUES ($1, 'events', $2)",
        device_id,
        NOW,
    )
    await migrated.execute(
        "INSERT INTO yawmi.push_subscriptions (endpoint, device_id, p256dh, auth) "
        "VALUES ('https://push.example/abc', $1, 'k', 'a')",
        device_id,
    )
    await migrated.execute(
        "INSERT INTO yawmi.pairing_codes (code, kind, expires_at) VALUES ('123456', 'web', $1)",
        NOW + timedelta(minutes=10),
    )


# ---------------------------------------------------------------------------
# Database tests: the yawmi_api role
# ---------------------------------------------------------------------------


@needs_db
async def test_role_attributes(migrated: asyncpg.Connection):
    row = await migrated.fetchrow(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, "
        "rolcanlogin, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'yawmi_api'"
    )
    assert row is not None
    assert row["rolcanlogin"] is True
    assert row["rolconnlimit"] == 5
    for flag in ("rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"):
        assert row[flag] is False, flag
    assert "search_path=yawmi" in (row["rolconfig"] or [])


async def _has(conn: asyncpg.Connection, relation: str, privilege: str) -> bool:
    return await conn.fetchval(
        f"SELECT has_table_privilege('yawmi_api', '{relation}', '{privilege}')"
    )


@needs_db
@pytest.mark.parametrize("table", YAWMI_TABLES)
async def test_role_privileges_on_yawmi_tables(migrated: asyncpg.Connection, table: str):
    rel = f"yawmi.{table}"
    for privilege in ("SELECT", "INSERT", "UPDATE"):
        assert await _has(migrated, rel, privilege), f"{rel} {privilege}"
    assert await _has(migrated, rel, "DELETE") is (table in DELETABLE), f"{rel} DELETE"
    for privilege in ("TRUNCATE", "REFERENCES", "TRIGGER"):
        assert not await _has(migrated, rel, privilege), f"{rel} {privilege}"


@needs_db
async def test_role_cannot_touch_the_migration_ledger(migrated: asyncpg.Connection):
    for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert not await _has(migrated, "yawmi.schema_migrations", privilege)


@needs_db
@pytest.mark.parametrize("relation", RAQIB_READABLE)
async def test_role_reads_but_never_writes_the_raqib_mirror(
    migrated: asyncpg.Connection, relation: str
):
    rel = f"raqib.{relation}"
    assert await _has(migrated, rel, "SELECT"), rel
    for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
        assert not await _has(migrated, rel, privilege), f"{rel} {privilege}"


@needs_db
async def test_role_cannot_read_other_raqib_tables(migrated: asyncpg.Connection):
    assert not await _has(migrated, "raqib.journal_entries", "SELECT")


@needs_db
async def test_role_schema_privileges(migrated: asyncpg.Connection):
    async def schema_priv(schema: str, privilege: str) -> bool:
        return await migrated.fetchval(
            f"SELECT has_schema_privilege('yawmi_api', '{schema}', '{privilege}')"
        )

    assert await schema_priv("yawmi", "USAGE")
    assert not await schema_priv("yawmi", "CREATE")
    assert await schema_priv("raqib", "USAGE")
    assert not await schema_priv("raqib", "CREATE")


@needs_db
async def test_role_behaviour_under_set_role(migrated: asyncpg.Connection):
    await insert_habit(migrated)
    await migrated.execute("SET ROLE yawmi_api")
    try:
        await migrated.execute(
            "INSERT INTO yawmi.pairing_codes (code, kind, expires_at) VALUES ('c1', 'web', $1)",
            NOW,
        )
        await migrated.execute("DELETE FROM yawmi.pairing_codes WHERE code = 'c1'")
        await migrated.execute("UPDATE yawmi.habits SET active = false WHERE code = 'h1'")
        assert await migrated.fetchval("SELECT count(*) FROM raqib.kpis") == 0
        with pytest.raises(pgerr.InsufficientPrivilegeError):
            await migrated.execute("DELETE FROM yawmi.habits WHERE code = 'h1'")
        with pytest.raises(pgerr.InsufficientPrivilegeError):
            await migrated.execute("SELECT 1 FROM raqib.journal_entries")
        with pytest.raises(pgerr.InsufficientPrivilegeError):
            await migrated.execute(
                "INSERT INTO raqib.kpis (code, name, unit, direction, frequency)"
                " VALUES ('x', 'x', 'x', 'up', 'daily')"
            )
        with pytest.raises(pgerr.InsufficientPrivilegeError):
            await migrated.execute("CREATE TABLE yawmi.probe (x int)")
        with pytest.raises(pgerr.InsufficientPrivilegeError):
            await migrated.execute("SELECT 1 FROM yawmi.schema_migrations")
    finally:
        await migrated.execute("RESET ROLE")


@needs_db
async def test_password_is_set_from_the_supplied_parameter(
    migrated: asyncpg.Connection, api_pw: str
):
    stored = await migrated.fetchval(
        "SELECT rolpassword FROM pg_authid WHERE rolname = 'yawmi_api'"
    )
    assert stored is not None
    assert stored.startswith("SCRAM-SHA-256$")
    assert api_pw not in stored


@needs_db
async def test_without_a_password_parameter_the_role_has_none(conn: asyncpg.Connection):
    assert DSN
    assert await migrate(DSN) == EXPECTED_FILES
    stored = await conn.fetchval("SELECT rolpassword FROM pg_authid WHERE rolname = 'yawmi_api'")
    assert stored is None


@needs_db
async def test_reapplying_the_role_migration_keeps_password_and_grants(
    migrated: asyncpg.Connection,
):
    assert DSN
    before = await migrated.fetchval(
        "SELECT rolpassword FROM pg_authid WHERE rolname = 'yawmi_api'"
    )
    await migrated.execute(
        "DELETE FROM yawmi.schema_migrations WHERE filename = '0002_yawmi_role.sql'"
    )
    assert await migrate(DSN) == ["0002_yawmi_role.sql"]  # no password parameter this time
    after = await migrated.fetchval("SELECT rolpassword FROM pg_authid WHERE rolname = 'yawmi_api'")
    assert after == before
    assert await _has(migrated, "yawmi.habits", "SELECT")
    assert not await _has(migrated, "yawmi.habits", "DELETE")


@needs_db
async def test_role_can_log_in_with_the_supplied_password(
    migrated: asyncpg.Connection, api_pw: str
):
    assert DSN
    target = urlsplit(DSN)
    if not target.hostname:
        pytest.skip("TEST_DATABASE_URL has no TCP host; cannot test a password login")
    api = await asyncpg.connect(
        user="yawmi_api",
        password=api_pw,
        host=target.hostname,
        port=target.port or 5432,
        database=target.path.lstrip("/"),
    )
    try:
        assert await api.fetchval("SELECT current_user") == "yawmi_api"
        assert await api.fetchval("SHOW search_path") == "yawmi"
        assert await api.fetchval("SELECT count(*) FROM habits") == 0  # resolved via search_path
        assert await api.fetchval("SELECT count(*) FROM raqib.goals") == 0
    finally:
        await api.close()
