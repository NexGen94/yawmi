"""System habits seed: `api/db/seed/habits.json` is the single source of truth.

`habits.sql` is generated from it (`api/tools/export_seed_sql.py`) and the checker
(`api/tools/check_habits_seed.py`) compares it with the acceptance criteria of `GOAL-2031.md`.
Everything here runs without Postgres except the `seed_habits(conn)` tests at the bottom, which
need `TEST_DATABASE_URL` (a database with the `yawmi` schema loaded) and are skipped without it.
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import date, time
from pathlib import Path
from types import ModuleType
from typing import Any
from uuid import uuid4

import asyncpg
import pytest

from yawmi.db import seed

API_DIR = Path(__file__).resolve().parents[1]
HABITS_JSON = API_DIR / "db" / "seed" / "habits.json"
HABITS_SQL = API_DIR / "db" / "seed" / "habits.sql"
CHECKER = API_DIR / "tools" / "check_habits_seed.py"
EXPORTER = API_DIR / "tools" / "export_seed_sql.py"

# code, title_ar, outcome, ac_ref, kind, unit, target_per_period, period, anchor
EXPECTED_ROWS = [
    ("meditation", "تأمّل 10 دقائق", "O2", "AC2.7", "boolean", None, 5, "week", "after_wake"),
    (
        "visualization",
        "تخيّل خطوات اليوم 5 دقائق",
        "O2",
        "AC2.7",
        "boolean",
        None,
        5,
        "week",
        "after_wake",
    ),
    ("journal_morning", "يومية الصباح", "O3", "AC3.4", "boolean", None, 5, "week", "after_wake"),
    ("journal_evening", "يومية المساء", "O3", "AC3.4", "boolean", None, 5, "week", "before_sleep"),
    ("english_minutes", "دقائق الإنجليزية", "O7", "AC7.4", "duration", "min", 285, "week", None),
    (
        "english_speaking",
        "جلسة محادثة إنجليزية",
        "O7",
        "AC7.4",
        "count",
        "session",
        2,
        "week",
        None,
    ),
    ("family_half_day", "نصف يوم الأسرة", "O11", "AC11.1", "boolean", None, 1, "week", None),
    ("social_initiative", "مبادرة اجتماعية", "O11", "AC11.2", "count", "session", 2, "week", None),
    ("trait_of_month", "ممارسة صفة الشهر", "O10", "AC10.4", "boolean", None, 1, "day", None),
    ("breathing", "تنفّس بطيء", "O2", None, "count", "session", 1, "day", "after_wake"),
]

SCHEMA_COLUMNS = {
    "code",
    "title_ar",
    "goal_ref",
    "outcome",
    "ac_ref",
    "kind",
    "unit",
    "target_per_period",
    "period",
    "schedule_kind",
    "weekday_mask",
    "every_n",
    "anchor_day",
    "anchor",
    "start_day",
    "end_day",
    "system",
    "created_by",
    "active",
}

SAMPLE_GOAL = """\
## O2
- [ ] AC2.6: معيار آخر لا علاقة له بالعادات.
- [ ] AC2.7: تأمل 10 دقائق وتخيّل لخطوات اليوم 5 دقائق في 5 أيام من 7، في 80% من الأسابيع.
## O3
- [ ] AC3.4: يوميات الصباح ويوميات المساء في 5 أيام من 7 على الأقل لكلٍّ منهما.
## O7
- [ ] AC7.4: ≥ 285 دقيقة إنجليزية مركّزة أسبوعياً، وجلستا محادثة، في 80% من الأسابيع.
## O10
- [ ] AC10.4: كل صفة سُجّلت ممارستها في 80% من أيام شهرها.
## O11
- [ ] AC11.1: نصف يوم الأسرة المحمي في 80% من الأسابيع.
- [ ] AC11.2: مبادرتان اجتماعيتان أسبوعياً في 80% من الأسابيع.
"""


def _load_script(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def checker() -> ModuleType:
    return _load_script(CHECKER, "check_habits_seed")


@pytest.fixture(scope="module")
def exporter() -> ModuleType:
    return _load_script(EXPORTER, "export_seed_sql")


@pytest.fixture
def habits() -> list[dict[str, Any]]:
    return seed.load_habits()


def _by_code(habits: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {h["code"]: h for h in habits}


# --- habits.json: the data ----------------------------------------------------------------------


def test_codes_are_unique(habits: list[dict[str, Any]]) -> None:
    duplicates = [code for code, n in Counter(h["code"] for h in habits).items() if n > 1]
    assert duplicates == []
    assert len(habits) == 10


def test_english_minutes_target_is_285_minutes(habits: list[dict[str, Any]]) -> None:
    english = _by_code(habits)["english_minutes"]
    assert english["target_per_period"] == 285
    assert english["unit"] == "min"
    assert english["kind"] == "duration"
    assert english["period"] == "week"


def test_every_habit_is_a_system_habit_created_by_seed(habits: list[dict[str, Any]]) -> None:
    for habit in habits:
        assert habit["system"] is True, habit["code"]
        assert habit["created_by"] == "seed", habit["code"]


def test_daily_boolean_habits_have_target_one(habits: list[dict[str, Any]]) -> None:
    daily_booleans = [h for h in habits if h["kind"] == "boolean" and h["period"] == "day"]
    assert daily_booleans, "expected at least trait_of_month"
    for habit in daily_booleans:
        assert habit["target_per_period"] == 1, habit["code"]


def test_weekly_boolean_target_is_a_count_of_days(habits: list[dict[str, Any]]) -> None:
    for habit in habits:
        if habit["kind"] == "boolean" and habit["period"] == "week":
            assert habit["target_per_period"] in range(1, 8), habit["code"]


def test_rows_match_the_brief(habits: list[dict[str, Any]]) -> None:
    rows = [
        (
            h["code"],
            h["title_ar"],
            h["outcome"],
            h["ac_ref"],
            h["kind"],
            h["unit"],
            h["target_per_period"],
            h["period"],
            h["anchor"],
        )
        for h in habits
    ]
    assert rows == EXPECTED_ROWS


def test_every_habit_carries_exactly_the_schema_columns(habits: list[dict[str, Any]]) -> None:
    for habit in habits:
        assert set(habit) == SCHEMA_COLUMNS, habit["code"]


def test_start_day_is_left_to_the_seeder(habits: list[dict[str, Any]]) -> None:
    # The seeder fills it with today in Riyadh, so no day before the app existed counts as missed.
    for habit in habits:
        assert habit["start_day"] is None, habit["code"]


def test_values_satisfy_the_schema_check_constraints(habits: list[dict[str, Any]]) -> None:
    for habit in habits:
        code = habit["code"]
        assert habit["kind"] in {"boolean", "count", "duration"}, code
        assert habit["unit"] in {None, "session", "min", "hour"}, code
        assert habit["period"] in {"day", "week", "month"}, code
        assert habit["anchor"] in {None, "after_wake", "before_sleep", "free"}, code
        assert habit["target_per_period"] > 0, code
        assert habit["created_by"] in {"seed", "user"}, code
        assert habit["outcome"] is None or re.fullmatch(r"O([1-9]|1[0-2])", habit["outcome"]), code
        assert habit["ac_ref"] is None or re.fullmatch(r"AC\d+\.\d+", habit["ac_ref"]), code
        # habits_period_schedule_chk: only daily habits may use another schedule
        assert habit["schedule_kind"] == "every_day", code
        assert habit["weekday_mask"] is None, code
        assert habit["every_n"] is None, code
        assert habit["anchor_day"] is None, code
        assert habit["end_day"] is None, code
        assert habit["active"] is True, code
        # a boolean has no unit; counts and durations always do
        assert (habit["unit"] is None) == (habit["kind"] == "boolean"), code


def test_outcome_agrees_with_the_acceptance_criterion(habits: list[dict[str, Any]]) -> None:
    for habit in habits:
        if habit["ac_ref"] is not None:
            assert habit["ac_ref"].startswith(f"AC{habit['outcome'][1:]}."), habit["code"]


def test_arabic_titles_are_plain_and_non_empty(habits: list[dict[str, Any]]) -> None:
    for habit in habits:
        title = habit["title_ar"]
        assert title == title.strip() and title, habit["code"]
        assert re.search(r"[؀-ۿ]", title), habit["code"]


# --- render_seed_sql ----------------------------------------------------------------------------


def test_render_seed_sql_is_an_idempotent_upsert_on_code(habits: list[dict[str, Any]]) -> None:
    sql = seed.render_seed_sql(habits)
    assert "INSERT INTO yawmi.habits" in sql
    assert "ON CONFLICT (code) DO UPDATE" in sql
    assert sql.count("INSERT INTO") == 1, "one statement: atomic under both psql and asyncpg"


def test_render_seed_sql_lists_every_code(habits: list[dict[str, Any]]) -> None:
    sql = seed.render_seed_sql(habits)
    for habit in habits:
        assert f"'{habit['code']}'" in sql
    assert len(habits) == 10


def test_render_seed_sql_fills_start_day_with_today_in_riyadh(
    habits: list[dict[str, Any]],
) -> None:
    sql = seed.render_seed_sql(habits)
    expr = "(now() AT TIME ZONE 'Asia/Riyadh')::date"
    assert f"start_day = COALESCE(yawmi.habits.start_day, {expr})" in sql
    assert expr in sql.split("VALUES", 1)[1].split("ON CONFLICT", 1)[0], "also the insert value"


def _update_clause(sql: str) -> str:
    return sql.split("DO UPDATE SET", 1)[1]


def test_render_seed_sql_never_overwrites_the_user_editable_fields(
    habits: list[dict[str, Any]],
) -> None:
    update = _update_clause(seed.render_seed_sql(habits))
    assert not re.search(r"\banchor\s*=", update), "anchor is the user's after seeding"
    assert "habit_reminders" not in seed.render_seed_sql(habits)
    # lifecycle state is not part of the seeded definition either
    assert not re.search(r"\bactive\s*=", update)
    assert not re.search(r"\bend_day\s*=", update)


def test_render_seed_sql_updates_the_system_definition(habits: list[dict[str, Any]]) -> None:
    update = _update_clause(seed.render_seed_sql(habits))
    for column in (
        "title_ar",
        "goal_ref",
        "outcome",
        "ac_ref",
        "kind",
        "unit",
        "target_per_period",
        "period",
        "schedule_kind",
        "system",
        "created_by",
    ):
        assert f"{column} = excluded.{column}" in update, column


def test_render_seed_sql_renders_values_as_sql_literals(habits: list[dict[str, Any]]) -> None:
    sql = seed.render_seed_sql(habits)
    assert "'english_minutes'" in sql
    assert "'min'" in sql
    assert "285" in sql
    assert "TRUE" in sql
    assert "NULL" in sql
    assert "تأمّل 10 دقائق" in sql


def test_render_seed_sql_is_deterministic(habits: list[dict[str, Any]]) -> None:
    assert seed.render_seed_sql(habits) == seed.render_seed_sql(list(habits))


def test_render_seed_sql_escapes_single_quotes(habits: list[dict[str, Any]]) -> None:
    tricky = [{**habits[0], "code": "o'brien", "title_ar": "عنوان 'مقتبس'"}]
    sql = seed.render_seed_sql(tricky)
    assert "'o''brien'" in sql
    assert "'عنوان ''مقتبس'''" in sql


def test_render_seed_sql_refuses_a_preset_start_day(habits: list[dict[str, Any]]) -> None:
    with pytest.raises(ValueError, match="start_day"):
        seed.render_seed_sql([{**habits[0], "start_day": "2026-10-31"}])


def test_render_seed_sql_refuses_missing_and_unknown_columns(habits: list[dict[str, Any]]) -> None:
    missing = {k: v for k, v in habits[0].items() if k != "kind"}
    with pytest.raises(ValueError, match="kind"):
        seed.render_seed_sql([missing])
    with pytest.raises(ValueError, match="bogus"):
        seed.render_seed_sql([{**habits[0], "bogus": 1}])


def test_render_seed_sql_refuses_duplicate_codes(habits: list[dict[str, Any]]) -> None:
    with pytest.raises(ValueError, match="duplicate"):
        seed.render_seed_sql([habits[0], habits[0]])


def test_render_seed_sql_refuses_an_empty_list() -> None:
    with pytest.raises(ValueError, match="empty"):
        seed.render_seed_sql([])


def test_committed_habits_sql_is_in_sync_with_habits_json(habits: list[dict[str, Any]]) -> None:
    # CI regenerates the file and runs `git diff --exit-code`; this is the same check, locally.
    assert HABITS_SQL.read_text(encoding="utf-8") == seed.render_seed_sql(habits)


def test_committed_habits_sql_uses_lf_only() -> None:
    assert b"\r" not in HABITS_SQL.read_bytes()


# --- export_seed_sql.py -------------------------------------------------------------------------


def test_exporter_writes_the_rendered_sql_with_lf(
    exporter: ModuleType, tmp_path: Path, habits: list[dict[str, Any]]
) -> None:
    out = tmp_path / "habits.sql"
    assert exporter.main(["--output", str(out)]) == 0
    assert out.read_bytes() == seed.render_seed_sql(habits).encode("utf-8")
    assert b"\r" not in out.read_bytes()


def test_exporter_reads_the_given_habits_file(exporter: ModuleType, tmp_path: Path) -> None:
    source = tmp_path / "habits.json"
    only = [h for h in seed.load_habits() if h["code"] == "breathing"]
    source.write_text(json.dumps(only, ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "out.sql"
    assert exporter.main(["--habits", str(source), "--output", str(out)]) == 0
    text = out.read_text(encoding="utf-8")
    assert "'breathing'" in text
    assert "'meditation'" not in text


# --- check_habits_seed.py -----------------------------------------------------------------------


def test_checker_passes_on_a_consistent_goal(
    checker: ModuleType, habits: list[dict[str, Any]]
) -> None:
    assert checker.check(habits, SAMPLE_GOAL) == []


def test_checker_flags_a_missing_acceptance_criterion(
    checker: ModuleType, habits: list[dict[str, Any]]
) -> None:
    goal = "\n".join(line for line in SAMPLE_GOAL.splitlines() if "AC7.4" not in line)
    violations = checker.check(habits, goal)
    assert violations
    assert all(v.startswith("خرق: ") for v in violations)
    assert any("AC7.4" in v for v in violations)


def test_checker_requires_the_open_checkbox_line_form(
    checker: ModuleType, habits: list[dict[str, Any]]
) -> None:
    # "AC7.4" mentioned in prose is not a criterion line
    goal = SAMPLE_GOAL.replace("- [ ] AC7.4:", "انظر AC7.4 في")
    assert any("AC7.4" in v for v in checker.check(habits, goal))


@pytest.mark.parametrize(
    ("code", "wrong_target", "needle"),
    [
        ("english_minutes", 280, "285"),
        ("english_speaking", 3, "2"),
        ("meditation", 4, "5"),
        ("visualization", 7, "5"),
        ("journal_morning", 6, "5"),
        ("social_initiative", 1, "2"),
        ("family_half_day", 2, "1"),
        ("trait_of_month", 2, "1"),
    ],
)
def test_checker_flags_a_target_that_disagrees_with_the_goal_line(
    checker: ModuleType,
    habits: list[dict[str, Any]],
    code: str,
    wrong_target: int,
    needle: str,
) -> None:
    changed = [{**h, "target_per_period": wrong_target} if h["code"] == code else h for h in habits]
    violations = checker.check(changed, SAMPLE_GOAL)
    assert len(violations) == 1, violations
    assert violations[0].startswith("خرق: ")
    assert code in violations[0]
    assert str(wrong_target) in violations[0]
    assert needle in violations[0]


def test_checker_reads_the_numbers_from_the_goal_not_from_a_constant(
    checker: ModuleType, habits: list[dict[str, Any]]
) -> None:
    goal = SAMPLE_GOAL.replace("285 دقيقة", "300 دقيقة").replace("5 أيام من 7", "4 أيام من 7")
    violations = checker.check(habits, goal)
    flagged = {code for code in _by_code(habits) if any(code in v for v in violations)}
    assert {"english_minutes", "meditation", "visualization"} <= flagged


def test_checker_understands_arabic_indic_digits(
    checker: ModuleType, habits: list[dict[str, Any]]
) -> None:
    goal = SAMPLE_GOAL.replace("285", "٢٨٥").replace("5 أيام من 7", "٥ أيام من ٧")
    assert checker.check(habits, goal) == []


def test_checker_flags_an_outcome_that_disagrees_with_its_criterion(
    checker: ModuleType, habits: list[dict[str, Any]]
) -> None:
    changed = [{**h, "outcome": "O4"} if h["code"] == "journal_evening" else h for h in habits]
    violations = checker.check(changed, SAMPLE_GOAL)
    assert any("journal_evening" in v and "O4" in v for v in violations)


def test_checker_skips_habits_without_an_ac_ref(
    checker: ModuleType, habits: list[dict[str, Any]]
) -> None:
    goal = "\n".join(line for line in SAMPLE_GOAL.splitlines() if "AC2.7" not in line)
    violations = checker.check([h for h in habits if h["code"] == "breathing"], goal)
    assert violations == []


def _run_checker(*args: str) -> subprocess.CompletedProcess[bytes]:
    # `-I` (isolated mode) is how the plan runs it: stdlib only, no project imports.
    return subprocess.run(
        [sys.executable, "-I", str(CHECKER), *args], capture_output=True, check=False
    )


def test_checker_cli_prints_no_violations_and_exits_zero(tmp_path: Path) -> None:
    goal = tmp_path / "GOAL-2031.md"
    goal.write_text(SAMPLE_GOAL, encoding="utf-8")
    result = _run_checker("--goal", str(goal))
    assert result.returncode == 0, result.stderr
    assert result.stdout.decode("utf-8").strip() == "لا خروق"


def test_checker_cli_prints_the_violation_and_exits_one(tmp_path: Path) -> None:
    goal = tmp_path / "GOAL-2031.md"
    goal.write_text(SAMPLE_GOAL.replace("285 دقيقة", "290 دقيقة"), encoding="utf-8")
    result = _run_checker("--goal", str(goal))
    assert result.returncode == 1
    out = result.stdout.decode("utf-8")
    assert out.startswith("خرق: ")
    assert "english_minutes" in out
    assert "290" in out


def test_checker_cli_reports_an_unreadable_goal_file(tmp_path: Path) -> None:
    result = _run_checker("--goal", str(tmp_path / "missing.md"))
    assert result.returncode == 1
    assert result.stdout.decode("utf-8").startswith("خرق: ")


def test_exporter_cli_runs_in_a_subprocess(tmp_path: Path) -> None:
    out = tmp_path / "habits.sql"
    result = subprocess.run(
        [sys.executable, str(EXPORTER), "--output", str(out)], capture_output=True, check=False
    )
    assert result.returncode == 0, result.stderr
    assert out.read_text(encoding="utf-8") == HABITS_SQL.read_text(encoding="utf-8")


# --- seed_habits(conn): needs Postgres ------------------------------------------------------------


@pytest.fixture
async def db():
    """A connection inside a transaction that is rolled back: the database stays untouched."""
    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("TEST_DATABASE_URL is not set: seed_habits needs a real Postgres")
    conn = await asyncpg.connect(dsn, server_settings={"search_path": "yawmi", "timezone": "UTC"})
    try:
        if await conn.fetchval("SELECT to_regclass('yawmi.habits')") is None:
            pytest.skip("schema yawmi is not loaded in TEST_DATABASE_URL: run the migrations first")
        transaction = conn.transaction()
        await transaction.start()
        try:
            # Other modules leave the system habits behind (with their own clock); start from none.
            # TRUNCATE is transactional, so the rollback below restores whatever was there.
            await conn.execute("TRUNCATE yawmi.habits CASCADE")
            yield conn
        finally:
            await transaction.rollback()
    finally:
        await conn.close()


async def test_seed_habits_inserts_every_system_habit(db: asyncpg.Connection) -> None:
    assert await seed.seed_habits(db) == 10
    rows = await db.fetch("SELECT * FROM yawmi.habits ORDER BY code")
    assert {r["code"] for r in rows} == {row[0] for row in EXPECTED_ROWS}
    english = next(r for r in rows if r["code"] == "english_minutes")
    assert english["target_per_period"] == 285
    assert english["unit"] == "min"
    assert english["system"] is True
    assert english["created_by"] == "seed"
    assert english["active"] is True
    today_riyadh = await db.fetchval("SELECT (now() AT TIME ZONE 'Asia/Riyadh')::date")
    assert all(r["start_day"] == today_riyadh for r in rows)


async def test_seeding_twice_keeps_an_anchor_edited_by_hand(db: asyncpg.Connection) -> None:
    await seed.seed_habits(db)
    await db.execute("UPDATE yawmi.habits SET anchor = 'free' WHERE code = 'meditation'")
    await db.execute("UPDATE yawmi.habits SET anchor = 'after_wake' WHERE code = 'english_minutes'")
    assert await seed.seed_habits(db) == 10
    anchors = {
        r["code"]: r["anchor"] for r in await db.fetch("SELECT code, anchor FROM yawmi.habits")
    }
    assert anchors["meditation"] == "free"
    assert anchors["english_minutes"] == "after_wake"
    assert anchors["journal_evening"] == "before_sleep"


async def test_reseeding_keeps_start_day_and_reminders(db: asyncpg.Connection) -> None:
    await seed.seed_habits(db)
    await db.execute(
        "UPDATE yawmi.habits SET start_day = DATE '2026-10-31' WHERE code = 'breathing'"
    )
    reminder_id = uuid4()
    await db.execute(
        "INSERT INTO yawmi.habit_reminders (id, habit_code, at_time) VALUES ($1, 'meditation', $2)",
        reminder_id,
        time(6, 30),
    )
    await seed.seed_habits(db)
    start_day = await db.fetchval("SELECT start_day FROM yawmi.habits WHERE code = 'breathing'")
    assert start_day == date(2026, 10, 31)
    reminders = await db.fetchval(
        "SELECT count(*) FROM yawmi.habit_reminders WHERE id = $1", reminder_id
    )
    assert reminders == 1


async def test_reseeding_restores_the_system_definition(db: asyncpg.Connection) -> None:
    await seed.seed_habits(db)
    await db.execute(
        "UPDATE yawmi.habits SET target_per_period = 99 WHERE code = 'english_minutes'"
    )
    await seed.seed_habits(db)
    target = await db.fetchval(
        "SELECT target_per_period FROM yawmi.habits WHERE code = 'english_minutes'"
    )
    assert target == 285
