"""Tests for the yawmi schema migrations and the ``yawmi_api`` role.

Two groups:

* Plain tests (no database): the migration runner's file handling and static
  guards on the SQL files themselves. These run everywhere.
* Database tests: need a real Postgres with a ``raqib`` database and a user allowed
  to create schemas and roles (superuser in CI). Locally they are skipped unless
  ``TEST_DATABASE_URL`` is set. When ``CI`` is set they never skip: a missing
  ``TEST_DATABASE_URL`` fails them, so CI cannot go green without a database. The real run
  happens in GitHub Actions (``.github/workflows/api-tests.yml``).
"""

import asyncio
import base64
import hashlib
import hmac
import importlib
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

from yawmi import admin
from yawmi.auth.pg_store import AsyncpgDeviceStore
from yawmi.db.migrate import (
    MIGRATIONS_DIR,
    MigrationError,
    clean_params,
    migrate,
    strip_transaction,
)

DSN = os.environ.get("TEST_DATABASE_URL")
IN_CI = bool(os.environ.get("CI"))
needs_db = pytest.mark.skipif(
    not DSN and not IN_CI, reason="TEST_DATABASE_URL is not set (database tests run in CI)"
)

STUB_SQL = Path(__file__).parent / "fixtures" / "raqib_stub.sql"
EXPECTED_FILES = ["0001_yawmi_schema.sql", "0002_yawmi_role.sql", "0003_yawmi_web.sql"]
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
    # 0003 (desktop web round)
    "user_settings",
    "ai_consents",
    "ai_memory",
    "journal_entries",
    "mood_logs",
    "goal_tasks",
    "goal_edits",
    "indicators",
    "focus_plans",
    "notice_sends",
]
DELETABLE = {"pairing_codes", "push_subscriptions", "ai_memory", "indicators"}
# Read in full (table-level SELECT).
RAQIB_WHOLE = ["notion_milestones", "goals", "cycles", "kpis", "v_journal_daily"]
# Read column by column: every column except the one named here (personal free text).
RAQIB_HIDDEN_COLUMN = {"notion_cards": "props", "kpi_readings": "note"}
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


async def test_migrate_rejects_a_missing_directory(tmp_path: Path):
    with pytest.raises(MigrationError, match="not found"):
        await migrate("postgresql://nobody@localhost:1/none", migrations_dir=tmp_path / "nope")


async def test_migrate_rejects_an_empty_directory(tmp_path: Path):
    with pytest.raises(MigrationError, match="no migration files"):
        await migrate("postgresql://nobody@localhost:1/none", migrations_dir=tmp_path)


def test_clean_params_strips_trailing_whitespace_only():
    cleaned = clean_params({"yawmi_api_pw": "  ab c\r\n", "other": "x \t\n"})
    assert cleaned == {"yawmi_api_pw": "  ab c", "other": "x"}


def test_clean_params_rejects_bad_names_and_non_strings():
    with pytest.raises(MigrationError):
        clean_params({"Bad-Name": "x"})
    with pytest.raises(MigrationError):
        clean_params({"ok": 1})  # type: ignore[dict-item]


# ---------------------------------------------------------------------------
# Database tests: migration 0003 (desktop web round)
# ---------------------------------------------------------------------------


@needs_db
async def test_0003_adds_the_four_columns(migrated: asyncpg.Connection):
    rows = await migrated.fetch(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = 'yawmi' AND (table_name, column_name) IN "
        "(('habits', 'polarity'), ('habits', 'identity_text'), "
        "('breath_sessions', 'feeling'), ('ai_insights', 'cards'))"
    )
    assert {(r["table_name"], r["column_name"]) for r in rows} == {
        ("habits", "polarity"),
        ("habits", "identity_text"),
        ("breath_sessions", "feeling"),
        ("ai_insights", "cards"),
    }
    await insert_habit(migrated)
    assert await migrated.fetchval("SELECT polarity FROM yawmi.habits WHERE code = 'h1'") == "build"


@needs_db
async def test_abstain_must_be_a_daily_boolean(migrated: asyncpg.Connection):
    with pytest.raises(pgerr.CheckViolationError):
        await insert_habit(migrated, polarity="abstain", kind="count")
    with pytest.raises(pgerr.CheckViolationError):
        await insert_habit(migrated, polarity="abstain", period="week")
    with pytest.raises(pgerr.CheckViolationError):
        await insert_habit(migrated, polarity="abstain", target_per_period=Decimal(2))
    await insert_habit(
        migrated,
        polarity="abstain",
        kind="boolean",
        period="day",
        target_per_period=Decimal(1),
    )
    with pytest.raises(pgerr.CheckViolationError):
        await insert_habit(migrated, code="h2", polarity="sideways")


@needs_db
async def test_identity_text_and_feeling_and_cards_checks(migrated: asyncpg.Connection):
    await insert_habit(migrated, identity_text="x" * 300)
    with pytest.raises(pgerr.CheckViolationError):
        await insert_habit(migrated, code="h2", identity_text="x" * 301)
    for bad in ("calm", ""):
        with pytest.raises(pgerr.CheckViolationError):
            await migrated.execute(
                "INSERT INTO yawmi.breath_sessions (id, day, started_at, pattern, feeling) "
                "VALUES ($1, $2, $3, 'p', $4)",
                uuid.uuid4(),
                date(2026, 11, 9),
                NOW,
                bad,
            )
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.ai_insights (id, kind, day, provider, model, request_hash, lines, "
            "cards) VALUES ($1, 'ask', $2, 'p', 'm', 'h', '[]', '{}')",
            uuid.uuid4(),
            date(2026, 11, 9),
        )


async def _insert_edit(conn: asyncpg.Connection, status: str = "pending") -> uuid.UUID:
    edit_id = uuid.uuid4()
    await conn.execute(
        "INSERT INTO yawmi.goal_edits (id, target_kind, page_id, field, new_value, note, status) "
        "VALUES ($1, 'milestone', 'page-1', 'done', 'true', 'n', $2)",
        edit_id,
        status,
    )
    return edit_id


@needs_db
async def test_one_pending_edit_per_page_and_field(migrated: asyncpg.Connection):
    first = await _insert_edit(migrated)
    with pytest.raises(pgerr.UniqueViolationError):
        await _insert_edit(migrated)
    await migrated.execute("UPDATE yawmi.goal_edits SET status = 'superseded' WHERE id = $1", first)
    await _insert_edit(migrated)
    await _insert_edit(migrated, status="applied")  # only pending rows are unique


@needs_db
async def test_goal_edit_checks(migrated: asyncpg.Connection):
    with pytest.raises(pgerr.CheckViolationError):
        await _insert_edit(migrated, status="done")
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.goal_edits (id, target_kind, page_id, field, new_value, note) "
            "VALUES ($1, 'outcome', 'p', 'f', '1', 'n')",
            uuid.uuid4(),
        )


@needs_db
@pytest.mark.parametrize("score", [0, 6])
async def test_mood_score_is_one_to_five(migrated: asyncpg.Connection, score: int):
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.mood_logs (day, score, logged_at) VALUES ($1, $2, $3)",
            date(2026, 11, 9),
            score,
            NOW,
        )
    await migrated.execute(
        "INSERT INTO yawmi.mood_logs (day, score, logged_at) VALUES ($1, 5, $2)",
        date(2026, 11, 9),
        NOW,
    )
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute("UPDATE yawmi.mood_logs SET feelings = '{}'::jsonb")


@needs_db
async def test_notice_is_sent_once_per_kind_ref_and_day(migrated: asyncpg.Connection):
    sql = "INSERT INTO yawmi.notice_sends (kind, ref, day) VALUES ($1, $2, $3)"
    await migrated.execute(sql, "late", "all", date(2026, 11, 9))
    with pytest.raises(pgerr.UniqueViolationError):
        await migrated.execute(sql, "late", "all", date(2026, 11, 9))
    await migrated.execute(sql, "late", "all", date(2026, 11, 10))


@needs_db
async def test_journal_and_memory_and_focus_plan_checks(migrated: asyncpg.Connection):
    ins = (
        "INSERT INTO yawmi.journal_entries (day, part, answers, logged_at) "
        "VALUES ($1, $2, '{}', $3)"
    )
    await migrated.execute(ins, date(2026, 11, 9), "morning", NOW)
    with pytest.raises(pgerr.UniqueViolationError):
        await migrated.execute(ins, date(2026, 11, 9), "morning", NOW)
    with pytest.raises(pgerr.CheckViolationError):
        await migrated.execute(ins, date(2026, 11, 9), "noon", NOW)
    mem = "INSERT INTO yawmi.ai_memory (id, kind, text) VALUES ($1, $2, $3)"
    await migrated.execute(mem, uuid.uuid4(), "rule", "x" * 300)
    for kind, text in (("rule", ""), ("rule", "x" * 301), ("fact", "a")):
        with pytest.raises(pgerr.CheckViolationError):
            await migrated.execute(mem, uuid.uuid4(), kind, text)
    plan = (
        "INSERT INTO yawmi.focus_plans (id, title_ar, minutes, weekday_mask, start_time) "
        "VALUES ($1, 't', $2, $3, $4)"
    )
    await migrated.execute(plan, uuid.uuid4(), 5, None, None)
    await migrated.execute(plan, uuid.uuid4(), 240, 127, time(7, 0))
    bad_plans = ((4, None, None), (241, None, None), (25, 3, None), (25, None, time(7)))
    for minutes, mask, at in bad_plans:
        with pytest.raises(pgerr.CheckViolationError):
            await migrated.execute(plan, uuid.uuid4(), minutes, mask, at)


@needs_db
async def test_indicator_checks(migrated: asyncpg.Connection):
    cols = (
        "INSERT INTO yawmi.indicators (id, subject_kind, subject_ref, source, measure, period, "
        "display, target, reminder_time, reminder_mask) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"
    )
    ok_goal = ("goal", "O1", "milestones", "completion", "all", "ring", None, None, None)
    await migrated.execute(cols, uuid.uuid4(), *ok_goal)
    with pytest.raises(pgerr.UniqueViolationError):
        await migrated.execute(cols, uuid.uuid4(), *ok_goal)
    habit = ("habit", "h1", "habit_logs", "avg_7d", "week", "bar", Decimal(3), None, None)
    await migrated.execute(cols, uuid.uuid4(), *habit)
    bad = [
        ("goal", "O2", "habit_logs", "completion", "all", "ring", None, None, None),
        ("goal", "O2", "tasks", "total", "all", "ring", None, None, None),
        ("habit", "h2", "tasks", "completion", "all", "ring", None, None, None),
        ("habit", "h2", "habit_logs", "completion", "year", "ring", None, None, None),
        ("habit", "h2", "habit_logs", "completion", "all", "pie", None, None, None),
        ("habit", "h2", "habit_logs", "completion", "all", "ring", Decimal(0), None, None),
        ("habit", "h2", "habit_logs", "completion", "all", "ring", None, time(8), 127),
        ("goal", "O2", "tasks", "completion", "all", "ring", None, time(8), None),
        ("thing", "x", "tasks", "completion", "all", "ring", None, None, None),
    ]
    for values in bad:
        with pytest.raises(pgerr.CheckViolationError):
            await migrated.execute(cols, uuid.uuid4(), *values)
    reminded = ("goal", "O3", "tasks", "completion", "all", "ring", None, time(8), 127)
    await migrated.execute(cols, uuid.uuid4(), *reminded)


@needs_db
async def test_card_fields_view_exposes_three_named_columns(migrated: asyncpg.Connection):
    cols = await migrated.fetch(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = 'yawmi_ro' AND table_name = 'notion_card_fields' "
        "ORDER BY ordinal_position"
    )
    assert [r["column_name"] for r in cols] == ["page_id", "target_date", "next_step"]
    await migrated.execute("DELETE FROM raqib.notion_cards")
    props_object = {
        "المستهدف": {"start": "2026-12-31", "end": None},
        "الخطوة التالية": "حجز الاختبار",
        "السبب العميق (لماذا؟)": "نص شخصي",
    }
    props_text = {"المستهدف": "2026-12-31"}
    for page_id, props in (("c1", props_object), ("c2", props_text), ("c3", {})):
        await migrated.execute(
            "INSERT INTO raqib.notion_cards (page_id, title, props) VALUES ($1, 't', $2::jsonb)",
            page_id,
            json.dumps(props, ensure_ascii=False),
        )
    try:
        await migrated.execute("SET ROLE yawmi_api")
        rows = {
            r["page_id"]: r
            for r in await migrated.fetch(
                "SELECT page_id, target_date, next_step FROM yawmi_ro.notion_card_fields"
            )
        }
        assert rows["c1"]["target_date"] == "2026-12-31"
        assert rows["c1"]["next_step"] == "حجز الاختبار"
        assert rows["c2"]["target_date"] == "2026-12-31"
        assert rows["c2"]["next_step"] is None
        assert rows["c3"]["target_date"] is None
        assert all("نص شخصي" not in str(tuple(r.values())) for r in rows.values())
        with pytest.raises(pgerr.InsufficientPrivilegeError):
            await migrated.fetch("SELECT props FROM raqib.notion_cards")
        for denied in (
            "INSERT INTO yawmi_ro.notion_card_fields (page_id) VALUES ('x')",
            "DELETE FROM yawmi_ro.notion_card_fields",
        ):
            with pytest.raises(pgerr.InsufficientPrivilegeError):
                await migrated.execute(denied)
    finally:
        await migrated.execute("RESET ROLE")
        await migrated.execute("DELETE FROM raqib.notion_cards")


@needs_db
async def test_0003_is_recorded_once(conn: asyncpg.Connection, api_pw: str):
    assert DSN
    await migrate(DSN, {"yawmi_api_pw": api_pw})
    assert await migrate(DSN) == []
    count = await conn.fetchval(
        "SELECT count(*) FROM yawmi.schema_migrations WHERE filename = '0003_yawmi_web.sql'"
    )
    assert count == 1


@needs_db
async def test_0003_grants_nothing_new_on_raqib(migrated: asyncpg.Connection):
    assert not await migrated.fetchval(
        "SELECT has_column_privilege('yawmi_api', 'raqib.notion_cards', 'props', 'SELECT')"
    )
    assert await _has(migrated, "yawmi_ro.notion_card_fields", "SELECT")
    for privilege in ("INSERT", "UPDATE", "DELETE"):
        assert not await _has(migrated, "yawmi_ro.notion_card_fields", privilege)


def test_ci_provides_a_database_url():
    if IN_CI:
        assert DSN, "CI is set but TEST_DATABASE_URL is not: the database tests cannot run"


def _scram_secret(password: str, salt_b64: str, iterations: int) -> tuple[bytes, bytes, bytes]:
    """(client_key, stored_key, server_key) of a SCRAM-SHA-256 secret (RFC 5802)."""
    salted = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), base64.b64decode(salt_b64), iterations
    )
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    return client_key, hashlib.sha256(client_key).digest(), server_key


def scram_matches(verifier: str, password: str) -> bool:
    """True if a Postgres ``rolpassword`` verifier was built from ``password``."""
    _, header, keys = verifier.split("$", 2)
    iterations, salt = header.split(":")
    _, stored_key, _ = _scram_secret(password, salt, int(iterations))
    return base64.b64encode(stored_key).decode() == keys.split(":")[0]


def test_scram_helper_reproduces_the_rfc_7677_example():
    # RFC 7677 section 3: user/"pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations.
    salt = "W22ZaJ0SNY7soEsUEjb6gQ=="
    auth_message = ",".join(
        [
            "n=user,r=rOprNGfwEbeRWgbNEkqO",
            "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=" + salt + ",i=4096",
            "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0",
        ]
    )
    client_key, stored_key, server_key = _scram_secret("pencil", salt, 4096)
    signature = hmac.new(stored_key, auth_message.encode(), hashlib.sha256).digest()
    proof = bytes(a ^ b for a, b in zip(client_key, signature, strict=True))
    assert base64.b64encode(proof).decode() == "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
    server_signature = hmac.new(server_key, auth_message.encode(), hashlib.sha256).digest()
    assert (
        base64.b64encode(server_signature).decode()
        == "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="
    )
    verifier = (
        f"SCRAM-SHA-256$4096:{salt}${base64.b64encode(stored_key).decode()}"
        f":{base64.b64encode(server_key).decode()}"
    )
    assert scram_matches(verifier, "pencil")
    assert not scram_matches(verifier, "pencil\n")


def test_migration_files_are_the_expected_set_in_order():
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
    # A psql loader must record the files it applies, or a later runner would re-apply them.
    assert "INSERT INTO yawmi.schema_migrations" in header
    assert "ON CONFLICT DO NOTHING" in header


# ---------------------------------------------------------------------------
# Database fixtures
# ---------------------------------------------------------------------------


async def _reset(conn: asyncpg.Connection) -> None:
    await conn.execute("DROP SCHEMA IF EXISTS yawmi CASCADE")
    await conn.execute("DROP SCHEMA IF EXISTS yawmi_ro CASCADE")
    if await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = 'yawmi_api'"):
        await conn.execute("DROP OWNED BY yawmi_api")
        await conn.execute("DROP ROLE yawmi_api")


@pytest.fixture
async def conn() -> AsyncIterator[asyncpg.Connection]:
    """Admin connection to a database with the raqib stub applied and yawmi wiped."""
    if not DSN:
        pytest.fail("CI is set but TEST_DATABASE_URL is not: cannot run the database tests")
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
async def test_files_apply_as_plain_sql_without_the_runner(conn: asyncpg.Connection):
    # What a psql loader does: execute each file as it is (its own BEGIN/COMMIT), then
    # record it. 0001 creates yawmi.schema_migrations itself, so 0002's REVOKE can resolve.
    assert DSN
    for name in EXPECTED_FILES:
        await conn.execute((MIGRATIONS_DIR / name).read_text(encoding="utf-8"))
        await conn.execute(
            "INSERT INTO yawmi.schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
            name,
        )
    recorded = await conn.fetch("SELECT filename FROM yawmi.schema_migrations ORDER BY filename")
    assert [r["filename"] for r in recorded] == EXPECTED_FILES
    assert await conn.fetchval("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'yawmi_api'")
    assert not await _has(conn, "yawmi.schema_migrations", "SELECT")
    assert await _has(conn, "yawmi.habits", "SELECT")
    # The Python runner then treats both as applied (and its bootstrap is a no-op).
    assert await migrate(DSN) == []


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
async def test_twenty_three_tables_exist(migrated: asyncpg.Connection):
    rows = await migrated.fetch(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'yawmi' AND table_type = 'BASE TABLE'"
    )
    names = {r["table_name"] for r in rows}
    assert names == set(YAWMI_TABLES) | {"schema_migrations"}
    assert len(set(YAWMI_TABLES)) == 23


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
async def test_device_refresh_rotated_at_is_a_nullable_timestamptz(migrated: asyncpg.Connection):
    row = await migrated.fetchrow(
        "SELECT data_type, is_nullable FROM information_schema.columns "
        "WHERE table_schema = 'yawmi' AND table_name = 'devices' "
        "AND column_name = 'refresh_rotated_at'"
    )
    assert row is not None
    assert row["data_type"] == "timestamp with time zone"
    assert row["is_nullable"] == "YES"


@pytest.fixture
async def device_store(migrated: asyncpg.Connection) -> AsyncIterator[AsyncpgDeviceStore]:
    assert DSN
    pool = await asyncpg.create_pool(DSN, min_size=2, max_size=2)
    try:
        yield AsyncpgDeviceStore(pool)
    finally:
        await pool.close()


@needs_db
async def test_pg_two_rotations_with_the_same_old_hash_give_exactly_one_success(
    device_store: AsyncpgDeviceStore,
):
    device_id = await device_store.create_device("هاتف", "iphone", "old-hash")
    ttl = timedelta(days=90)
    results = await asyncio.gather(
        device_store.rotate_refresh(device_id, "old-hash", "new-a", max_age=ttl),
        device_store.rotate_refresh(device_id, "old-hash", "new-b", max_age=ttl),
    )
    assert sorted(results) == [False, True]
    device = await device_store.get_device(device_id)
    assert device is not None
    assert device.refresh_hash in {"new-a", "new-b"}


@needs_db
async def test_pg_rotation_sets_the_timestamp_and_refuses_an_expired_token(
    migrated: asyncpg.Connection, device_store: AsyncpgDeviceStore
):
    device_id = await device_store.create_device("هاتف", "iphone", "h0")
    created = await migrated.fetchval(
        "SELECT refresh_rotated_at FROM yawmi.devices WHERE id = $1", device_id
    )
    assert created is not None
    ttl = timedelta(days=90)
    assert await device_store.rotate_refresh(device_id, "h0", "h1", max_age=ttl)
    rotated = await migrated.fetchval(
        "SELECT refresh_rotated_at FROM yawmi.devices WHERE id = $1", device_id
    )
    assert rotated >= created

    await migrated.execute(
        "UPDATE yawmi.devices SET refresh_rotated_at = now() - interval '91 days' WHERE id = $1",
        device_id,
    )
    assert not await device_store.rotate_refresh(device_id, "h1", "h2", max_age=ttl)
    device = await device_store.get_device(device_id)
    assert device is not None
    assert device.refresh_hash == "h1"


@needs_db
async def test_pg_admin_lists_devices_and_revokes_one_with_its_subscriptions(
    migrated: asyncpg.Connection, device_store: AsyncpgDeviceStore
):
    phone = await device_store.create_device("هاتف", "iphone", "a" * 64)
    web = await device_store.create_device("Safari", "web", "b" * 64)
    await migrated.execute(
        "INSERT INTO yawmi.push_subscriptions (endpoint, device_id, p256dh, auth) "
        "VALUES ('https://web.push.apple.com/x', $1, 'k', 'a')",
        web,
    )
    listed = await device_store.list_devices()
    assert {d.id for d in listed} == {phone, web}
    assert all(not hasattr(d, "refresh_hash") for d in listed)

    assert await admin.revoke_device(device_store, web) is True
    assert (
        await migrated.fetchval(
            "SELECT count(*) FROM yawmi.push_subscriptions WHERE device_id = $1", web
        )
        == 0
    )
    revoked = await migrated.fetchrow(
        "SELECT revoked_at, refresh_hash FROM yawmi.devices WHERE id = $1", web
    )
    assert revoked["revoked_at"] is not None
    assert revoked["refresh_hash"] is None
    assert await admin.revoke_device(device_store, uuid.uuid4()) is False


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
    "VALUES ($1, 'h1', $2, $3, 'done', $5, $4) "
    "ON CONFLICT (habit_code, day) DO UPDATE "
    "SET value = excluded.value, source = excluded.source, logged_at = excluded.logged_at "
    "WHERE excluded.logged_at >= yawmi.habit_logs.logged_at"
)


@needs_db
async def test_habit_log_is_unique_per_habit_and_day_and_latest_write_wins(
    migrated: asyncpg.Connection,
):
    """One row per habit and day whatever the device kind (I-10); `source` is the last writer."""
    await insert_habit(migrated)
    day = date(2026, 11, 9)
    newer, older = NOW, NOW - timedelta(minutes=5)
    # The newer edit (phone) arrives first, the older one (web) afterwards: the newer stays.
    await migrated.execute(UPSERT, uuid.uuid4(), day, Decimal(45), newer, "iphone")
    await migrated.execute(UPSERT, uuid.uuid4(), day, Decimal(30), older, "web")
    rows = await migrated.fetch("SELECT value, source, logged_at FROM yawmi.habit_logs")
    assert [(r["value"], r["source"], r["logged_at"]) for r in rows] == [
        (Decimal(45), "iphone", newer)
    ]
    # A later edit from another kind replaces the value and becomes the source.
    later = NOW + timedelta(minutes=5)
    await migrated.execute(UPSERT, uuid.uuid4(), day, Decimal(50), later, "watch")
    rows = await migrated.fetch("SELECT value, source FROM yawmi.habit_logs")
    assert [(r["value"], r["source"]) for r in rows] == [(Decimal(50), "watch")]
    # Without ON CONFLICT the same habit and day is a hard error, from any source.
    for source in ("watch", "web"):
        with pytest.raises(pgerr.UniqueViolationError):
            await migrated.execute(
                "INSERT INTO yawmi.habit_logs (id, habit_code, day, status, source, logged_at) "
                "VALUES ($1, 'h1', $2, 'skip', $3, $4)",
                uuid.uuid4(),
                day,
                source,
                NOW,
            )
    # Another day is a separate row.
    await migrated.execute(
        "INSERT INTO yawmi.habit_logs (id, habit_code, day, status, source, logged_at) "
        "VALUES ($1, 'h1', $2, 'done', 'watch', $3)",
        uuid.uuid4(),
        day + timedelta(days=1),
        NOW,
    )


@needs_db
async def test_habit_log_requires_a_habit(migrated: asyncpg.Connection):
    with pytest.raises(pgerr.NotNullViolationError):
        await migrated.execute(
            "INSERT INTO yawmi.habit_logs (id, habit_code, day, status, source, logged_at) "
            "VALUES ($1, NULL, $2, 'done', 'web', $3)",
            uuid.uuid4(),
            date(2026, 11, 9),
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
    assert row["data_quality"] == "missing"
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
async def test_daily_metrics_data_quality_is_a_label(migrated: asyncpg.Connection):
    insert = "INSERT INTO yawmi.daily_metrics (day, data_quality) VALUES ($1, $2)"
    for offset, label in enumerate(("missing", "low", "ok")):
        await migrated.execute(insert, date(2026, 11, 1) + timedelta(days=offset), label)
    for bad in ("great", "OK", "", "{}"):
        with pytest.raises(pgerr.CheckViolationError):
            await migrated.execute(insert, date(2026, 11, 20), bad)
    with pytest.raises(pgerr.NotNullViolationError):
        await migrated.execute(insert, date(2026, 11, 21), None)


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
@pytest.mark.parametrize("relation", RAQIB_WHOLE)
async def test_role_reads_these_raqib_relations_in_full(
    migrated: asyncpg.Connection, relation: str
):
    assert await _has(migrated, f"raqib.{relation}", "SELECT"), relation


@needs_db
@pytest.mark.parametrize(("relation", "hidden"), list(RAQIB_HIDDEN_COLUMN.items()))
async def test_role_reads_every_column_except_the_hidden_one(
    migrated: asyncpg.Connection, relation: str, hidden: str
):
    rel = f"raqib.{relation}"
    columns = [
        r["column_name"]
        for r in await migrated.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'raqib' AND table_name = $1",
            relation,
        )
    ]
    assert hidden in columns
    assert len(columns) > 1
    assert not await _has(migrated, rel, "SELECT"), f"{rel}: table-level SELECT must be absent"
    for column in columns:
        readable = await migrated.fetchval(
            f"SELECT has_column_privilege('yawmi_api', '{rel}', '{column}', 'SELECT')"
        )
        assert readable is (column != hidden), f"{rel}.{column}"


@needs_db
@pytest.mark.parametrize("relation", [*RAQIB_WHOLE, *RAQIB_HIDDEN_COLUMN])
async def test_role_never_writes_the_raqib_mirror(migrated: asyncpg.Connection, relation: str):
    rel = f"raqib.{relation}"
    for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
        assert not await _has(migrated, rel, privilege), f"{rel} {privilege}"
    for privilege in ("INSERT", "UPDATE"):
        any_column = await migrated.fetchval(
            f"SELECT has_any_column_privilege('yawmi_api', '{rel}', '{privilege}')"
        )
        assert not any_column, f"{rel} column {privilege}"


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
        assert await migrated.fetchval("SELECT count(page_id) FROM raqib.notion_cards") == 0
        assert await migrated.fetchval("SELECT count(value) FROM raqib.kpi_readings") == 0
        for hidden_read in (
            "SELECT props FROM raqib.notion_cards",
            "SELECT * FROM raqib.notion_cards",
            "SELECT note FROM raqib.kpi_readings",
            "SELECT * FROM raqib.kpi_readings",
        ):
            with pytest.raises(pgerr.InsufficientPrivilegeError):
                await migrated.execute(hidden_read)
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
    assert scram_matches(stored, api_pw)
    assert not scram_matches(stored, api_pw + "x")


@needs_db
async def test_trailing_newline_in_the_password_value_is_stripped(
    conn: asyncpg.Connection, api_pw: str
):
    assert DSN
    await migrate(DSN, {"yawmi_api_pw": api_pw + "\n"})  # as read_text() of a secret file
    stored = await conn.fetchval("SELECT rolpassword FROM pg_authid WHERE rolname = 'yawmi_api'")
    assert scram_matches(stored, api_pw)
    assert not scram_matches(stored, api_pw + "\n")


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


# ---------------------------------------------------------------------------
# Grant coverage (C-1(b)): every statement of every store, planned as yawmi_api
# ---------------------------------------------------------------------------

STORE_MODULES = (
    "yawmi.events.store",
    "yawmi.habits.store",
    "yawmi.today.reader",
    "yawmi.push.store",
    "yawmi.health.store",
    "yawmi.ai.store",
    "yawmi.auth.pg_store",
    "yawmi.journal.store",
    "yawmi.prefs.store",
    "yawmi.indicators.store",
    "yawmi.goals.reader",
    "yawmi.goals.tasks_store",
)
_SQL_START = re.compile(r"\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b", re.IGNORECASE)


def store_sql() -> dict[str, str]:
    """Every module-level SQL string of the stores, by `module.NAME`."""
    found: dict[str, str] = {}
    for name in STORE_MODULES:
        module = importlib.import_module(name)
        for attr, value in vars(module).items():
            if isinstance(value, str) and _SQL_START.match(value):
                found[f"{name}.{attr}"] = value
    return found


def test_every_store_module_has_named_sql_to_check():
    sql = store_sql()
    for module in STORE_MODULES:
        assert any(key.startswith(module + ".") for key in sql), module
    # the AI store's statements were inline; they are named now so the check can reach them
    for name in ("_LOCK", "_GET_CLOSURE", "_INSERT_INSIGHT", "_LIST_REVIEWS"):
        assert f"yawmi.ai.store.{name}" in sql
    assert "yawmi.auth.pg_store._EXPIRE_PAIRING_CODES" in sql
    assert "yawmi.auth.pg_store._LIST_DEVICES" in sql


@needs_db
async def test_yawmi_api_can_plan_every_store_statement(migrated: asyncpg.Connection):
    """`EXPLAIN (GENERIC_PLAN)` checks privileges (columns included) without running anything.

    Every failure is collected, so one run names every missing grant or misread column.
    """
    problems: list[str] = []
    await migrated.execute("SET ROLE yawmi_api")
    await migrated.execute("SET search_path = yawmi")  # as the pool does
    try:
        for key, sql in sorted(store_sql().items()):
            try:
                await migrated.execute(f"EXPLAIN (GENERIC_PLAN) {sql}")
            except pgerr.InsufficientPrivilegeError as exc:
                problems.append(f"{key}: insufficient_privilege: {exc}")
            except asyncpg.PostgresError as exc:
                problems.append(f"{key}: {type(exc).__name__}: {exc}")
    finally:
        await migrated.execute("RESET search_path")
        await migrated.execute("RESET ROLE")
    assert problems == []


GRANTS_SECTION = re.compile(
    r"^REVOKE ALL ON ALL TABLES IN SCHEMA yawmi_ro.*", re.MULTILINE | re.DOTALL
)
NEW_TABLES = [
    "user_settings",
    "ai_consents",
    "ai_memory",
    "journal_entries",
    "mood_logs",
    "goal_tasks",
    "goal_edits",
    "indicators",
    "focus_plans",
    "notice_sends",
]


def grants_section() -> str:
    """The re-runnable grants block of 0003 (the file's own BEGIN/COMMIT are not part of it)."""
    text = (MIGRATIONS_DIR / "0003_yawmi_web.sql").read_text(encoding="utf-8")
    section = GRANTS_SECTION.search(text)
    assert section
    return section.group(0).replace("COMMIT;", "")


async def _reapply_0002(conn: asyncpg.Connection) -> None:
    assert DSN
    await conn.execute("DELETE FROM yawmi.schema_migrations WHERE filename = '0002_yawmi_role.sql'")
    assert await migrate(DSN) == ["0002_yawmi_role.sql"]


async def _as_api(conn: asyncpg.Connection, sql: str) -> None:
    await conn.execute("SET ROLE yawmi_api")
    try:
        await conn.execute(sql)
    finally:
        await conn.execute("RESET ROLE")


@needs_db
async def test_view_stays_read_only_after_reapplying_0002(migrated: asyncpg.Connection):
    await migrated.execute(
        "INSERT INTO raqib.notion_cards (page_id, title) VALUES ('w1', 't') ON CONFLICT DO NOTHING"
    )
    try:
        await _reapply_0002(migrated)  # 0002 -> 0003 -> 0002, without re-running 0003
        for write in (
            "UPDATE yawmi_ro.notion_card_fields SET page_id = page_id",
            "UPDATE yawmi_ro.notion_card_fields SET page_id = 'hijack'",
            "INSERT INTO yawmi_ro.notion_card_fields (page_id) VALUES ('x')",
            "DELETE FROM yawmi_ro.notion_card_fields",
        ):
            with pytest.raises(pgerr.InsufficientPrivilegeError):
                await _as_api(migrated, write)
        await _as_api(migrated, "SELECT * FROM yawmi_ro.notion_card_fields")
        with pytest.raises(pgerr.InsufficientPrivilegeError):
            await _as_api(migrated, "SELECT props FROM raqib.notion_cards")
        assert (
            await migrated.fetchval("SELECT count(*) FROM raqib.notion_cards WHERE page_id = 'w1'")
            == 1
        )
        # nothing in yawmi_ro beyond USAGE on the schema and SELECT on the view
        assert await migrated.fetchval(
            "SELECT has_schema_privilege('yawmi_api', 'yawmi_ro', 'USAGE')"
        )
        assert not await migrated.fetchval(
            "SELECT has_schema_privilege('yawmi_api', 'yawmi_ro', 'CREATE')"
        )
        assert await _has(migrated, "yawmi_ro.notion_card_fields", "SELECT")
        for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
            assert not await _has(migrated, "yawmi_ro.notion_card_fields", privilege), privilege
        granted = await migrated.fetch(
            "SELECT privilege_type FROM information_schema.role_table_grants "
            "WHERE grantee = 'yawmi_api' AND table_schema = 'yawmi_ro'"
        )
        assert [r["privilege_type"] for r in granted] == ["SELECT"]
    finally:
        await migrated.execute("DELETE FROM raqib.notion_cards WHERE page_id = 'w1'")


@needs_db
async def test_0003_grants_are_reasserted_after_0002(migrated: asyncpg.Connection):
    await _reapply_0002(migrated)
    # the state right after 0002 -> 0003 -> 0002, loader 3 not yet re-run
    assert not await _has(migrated, "yawmi.ai_memory", "DELETE")
    assert not await _has(migrated, "yawmi.indicators", "DELETE")
    for _ in range(2):  # two runs in a row, no error, same end state
        await migrated.execute(grants_section())
    assert await _has(migrated, "yawmi.ai_memory", "DELETE")
    assert await _has(migrated, "yawmi.indicators", "DELETE")
    await _as_api(migrated, "DELETE FROM yawmi.ai_memory WHERE false")
    await _as_api(migrated, "DELETE FROM yawmi.indicators WHERE false")
    await _as_api(migrated, "SELECT * FROM yawmi_ro.notion_card_fields")
    for table in YAWMI_TABLES:
        for privilege in ("SELECT", "INSERT", "UPDATE"):
            assert await _has(migrated, f"yawmi.{table}", privilege), (table, privilege)
        assert await _has(migrated, f"yawmi.{table}", "DELETE") is (table in DELETABLE), table
    assert not await _has(migrated, "yawmi_ro.notion_card_fields", "UPDATE")


@needs_db
async def test_grants_block_is_a_full_reset_of_the_ten_tables_and_yawmi_ro(
    migrated: asyncpg.Connection,
):
    # wrong grants planted by hand: DELETE and TRUNCATE where the design allows neither,
    # and a write on the view
    await migrated.execute(
        "GRANT DELETE, TRUNCATE ON yawmi.goal_edits, yawmi.mood_logs TO yawmi_api"
    )
    await migrated.execute("GRANT UPDATE ON yawmi_ro.notion_card_fields TO yawmi_api")
    await migrated.execute("GRANT CREATE ON SCHEMA yawmi_ro TO yawmi_api")
    await migrated.execute("REVOKE UPDATE ON yawmi.journal_entries FROM yawmi_api")
    assert await _has(migrated, "yawmi.goal_edits", "DELETE")
    await migrated.execute(grants_section())
    for table in NEW_TABLES:
        for privilege in ("SELECT", "INSERT", "UPDATE"):
            assert await _has(migrated, f"yawmi.{table}", privilege), (table, privilege)
        assert await _has(migrated, f"yawmi.{table}", "DELETE") is (table in DELETABLE), table
        assert not await _has(migrated, f"yawmi.{table}", "TRUNCATE"), table
    assert not await _has(migrated, "yawmi_ro.notion_card_fields", "UPDATE")
    assert not await migrated.fetchval(
        "SELECT has_schema_privilege('yawmi_api', 'yawmi_ro', 'CREATE')"
    )
