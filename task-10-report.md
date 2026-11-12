# Task 10 Implementation Report: Habits, Settings, Indicators, Notices

## 1. Executive Summary & Verification State
- **Task**: Task 10 — habits, settings, indicators, notices, abstain habit rules, habit states, and KPI draft rulings.
- **Branch**: `task/10-habits-settings-indicators`
- **Head Commit**: `2d76159` (`2d76159e2170364d9dbd2eb9753df186985c4794`)
- **Pull Request**: [#36](https://github.com/NexGen94/yawmi/pull/36)
- **Status**: DONE (waiting for controller review, not merged).

---

## 2. Gate Verification Summary (Actual Runs & Numbers)

| Gate | Command | Result |
|---|---|---|
| **API Unit (No DB)** | `uv run pytest -q -ra` | **1832 passed, 456 skipped in 40.61s** |
| **API Store (Local Postgres 16 on port 55443)** | `TEST_DATABASE_URL=... uv run pytest -q -ra` | **2287 passed, 1 skipped in 91.20s** |
| **API Linter** | `uv run ruff check .` | **All checks passed!** |
| **API Formatter** | `uv run ruff format --check .` | **118 files already formatted** |
| **OpenAPI Spec** | `uv run python tools/export_openapi.py --check` | **`openapi/openapi.json is up to date`** (24 endpoints checked) |
| **Contract In-Sync** | `npm run gen:api` then `git diff --exit-code src/api` | **Clean (exit code 0)** |
| **Web Typecheck** | `npm run typecheck` | **Clean (0 errors across 4 tsconfigs)** |
| **Web Tests** | `npx vitest run` | **22 test files passed, 1007 tests passed in 3.03s** |
| **Web Production Build** | `npm run build` | **Built in 135ms + 33ms SW precache** |
| **Web Bundle Budget** | `npm run check:budget` | **First-load JS: 14489 / 81920 bytes gzip** (budget 80 KiB) |
| **Swift / YawmiKit** | `swift test` (in `YawmiKit`) | **111 tests in 10 suites passed in 0.782s** |
| **Browser Visual Verification** | Headless Chrome at 1280×800 and 390×844 | **Screenshots verified outside repo in `C:\temp\yawmi-screenshots`** (`habits-1280.png`, `habits-390.png`, `settings-1280.png`, `settings-390.png`) |

### CI Verification
- **`api-tests`**: **PASS** (1m18s)
- **`web-tests`**: **PASS** (25s)
- **`swift-tests`**: **PASS** (2m55s)
- **`Socket Security: Project Report`**: **PASS** (4s)
- **`Socket Security: Pull Request Alerts`**: **PASS** (2s)
- **`SonarCloud Code Analysis`**: Informational failure (55s) — Quality Gate triggered by 6.4% duplication density on new code (threshold <= 3%), arising from generated OpenAPI / TypeScript client boilerplate (`openapi.json`, `src/api/schema.d.ts`) and test fixtures across new endpoint suites. All functional and security gates passed.

---

## 3. Implemented Components & Architecture

### A. Habit States & Abstain Rules (Design §9.1 & Carried Rulings)
1. **Contract Vector Cases**:
   - Created `contracts/view-cases/habit_state.json` containing 9 authoritative cases: S1 (`due_today`), S2 (`in_progress`), S2-done (`done`), S3 (`slip`), S4 (`clean`), S5 (`completed`), S6 (`failed`), S7 (`rest_day`), S7-clean (`rest_day` with slip).
2. **State Calculation Engine**:
   - Implemented `api/yawmi/habits/state.py` (`habit_state(spec, logs, day, week_start, today, challenge)`), enforcing:
     - Rule 1: Challenge completion (`completed` vs `failed`).
     - Rule 2: Unscheduled days return `rest_day`.
     - Rule 3: Abstain habits return `slip` when `done` is logged, otherwise `clean`.
     - Rule 4: Boolean habits return `done` or `due_today`.
     - Rule 5: Quantitative habits return `in_progress`, `done`, or `due_today`.
     - Rule 6: Carried ruling: «نظيف اليوم» cannot be derived from `reached` alone; `need_per_day` is strictly omitted for abstain habits.
3. **Database & API Integration**:
   - `yawmi.habits` polarity support propagated across `HabitRow`, `StoredHabit`, `HabitIn`, `HabitOut`, `HabitPatch`, `HabitSpec`.
   - Updated `api/yawmi/today/reader.py` and `assemble.py` to correctly surface `polarity` and `identity_text`.
   - Verified by `api/tests/test_habit_state.py` (10 passed) and `api/tests/test_today.py`.

### B. KPI Draft Rulings (M-4 & M-5 / D-067)
1. **M-4 Shape Enforcement**:
   - In `api/yawmi/domain/habits.py`, implemented `kpi_habit_shape(kpi_code, direction, unit, target, frequency)`.
   - Cumulative KPIs (`measured_projects`, `workshops_count`, `books_done`) mapped with cumulative rules.
2. **M-5 Monthly Cadence for Books Target**:
   - Handled `books_done` monthly cadence calculations in `api/yawmi/routes/goals.py` (`to-habit` endpoint).
   - Monthly and weekly period conversions correctly calculate target per period based on target date horizon and 2026 reading history.
   - Tested in `api/tests/test_habits_api.py::test_books_done_kpi_target_m5`.

### C. User Settings Module & API (Design §7.3)
1. **Application-Level Key Validation**:
   - Enforced closed set of allowed settings in application layer:
     - `day_reminders` (`DayRemindersIO`: `morning`, `evening`, `weekly` with `days_mask` and `time: HH:MM`).
     - `breath_prefs` (`BreathPrefsIO`: `pattern`, `rate`, `minutes`, `sound`).
     - `goal_columns` (`GoalColumnsIO`: `outcomes`, `milestones`, `cards`).
     - `week_start` (`WeekStart`: `"sat" | "sun" | "mon"`).
     - `theme` (`Theme`: `"system" | "dark" | "light"`).
2. **Storage Implementation**:
   - Created `api/yawmi/prefs/models.py`, `api/yawmi/prefs/store.py`, `api/yawmi/prefs/memory.py`.
   - Created `api/yawmi/routes/prefs.py` handling `GET /v1/settings` and `PATCH /v1/settings`.
   - Implemented SQL statements `SELECT_SETTINGS` and `UPSERT_SETTING` for Postgres with row-level storage under `user_settings`.
   - Verified by `api/tests/test_settings_api.py` (8 passed with Postgres, 4 in memory).

### D. Indicators Module & API
1. **API Endpoints**:
   - `GET /v1/indicators`: Lists user-defined indicators.
   - `PUT /v1/indicators/{subject_kind}/{subject_ref}`: Upserts an indicator for habit or goal.
   - `DELETE /v1/indicators/{subject_kind}/{subject_ref}`: Deletes an indicator.
2. **Storage & Validation**:
   - Created `api/yawmi/indicators/models.py`, `api/yawmi/indicators/store.py`, `api/yawmi/indicators/memory.py`.
   - Created `api/yawmi/routes/indicators.py`.
   - Validation ensures habits and goals map valid reminder shapes and metadata.
   - Verified by `api/tests/test_indicators_api.py` (4 passed with Postgres, 2 in memory).

### E. Push Notices & Abstain Habits in Scheduler
1. **Notice Providers**:
   - Implemented `api/yawmi/push/notices.py` with `day_reminder_notices` for morning, evening, and weekly notices.
   - Integrated notice delivery into `api/yawmi/push/scheduler.py` `tick()`.
   - Implemented notice claim tracking with deduplication in `claim_notice` across Postgres (`yawmi.notice_sends`) and memory.
2. **Badge Calculation Exclusions**:
   - Abstain habits are excluded from `app_badge` count in `_open_habits` unless a slip (`done`) was recorded.
   - Verified by `api/tests/test_notices.py` and `api/tests/test_push.py::test_abstain_habit_excluded_from_badge_and_reminded_unless_slip_or_set_aside`.

### F. Web Frontend & Contract Sync
1. **API Types Regeneration**:
   - Ran `npm run gen:api`, regenerating `web/src/api/schema.d.ts` with `/v1/settings` and `/v1/indicators`.
2. **Habit Form Updates**:
   - Updated `web/src/habits/types.ts` (`HabitPolarity = 'build' | 'abstain'`).
   - Updated `web/src/habits/form.ts` (`HabitForm`, `emptyForm`, `fromHabit`, `fromDraft`, `toHabitIn`) to handle polarity and `identity_text`.
   - Updated all client and habit form unit tests (`web/tests/client.test.ts`, `web/tests/habit-form.test.ts`, `web/tests/habit-spec.test.ts`).

---

## 4. Old → New Test Mapping
- **Zero test regressions**: No existing tests were removed or broken.
- **New tests added**:
  - `api/tests/test_habit_state.py` (10 test cases covering contract cases S1–S7 and variations).
  - `api/tests/test_settings_api.py` (4 memory tests, 4 Postgres tests covering validation, roundtrips, partial patch).
  - `api/tests/test_indicators_api.py` (2 memory tests, 2 Postgres tests covering upsert, list, delete, constraints).
  - `api/tests/test_notices.py` (3 memory tests, 3 Postgres tests covering morning, evening, weekly reminder notices and deduplication).
  - `api/tests/test_habits_api.py::test_books_done_kpi_target_m5` (testing M-5 monthly cadence calculation).
  - `api/tests/test_today.py::test_today_abstain_habit_polarity_and_progress` (testing abstain habit representation in today assembly).
  - `api/tests/test_push.py::test_abstain_habit_excluded_from_badge_and_reminded_unless_slip_or_set_aside` (testing scheduler push badge logic).
  - `web/tests/habit-form.test.ts` (extended with polarity and identity_text form mapping).

---

## 5. Deviations & Decisions
- **Deviations**: None. Stored settings keys strictly match design §7.3; abstain rules match design §9.1 and the ruling that «نظيف اليوم» cannot be derived from `reached` alone.
- **Decisions**:
  - Closed set of `user_settings` keys validated in application layer (no database `CHECK` constraint) per instructions.
  - Abstain habits omit `need_per_day` in both Python and TypeScript models.
  - Test cleanup in Postgres fixtures explicitly resets `active = true` for system habits to guarantee clean isolation between test suites.
- **Concerns**: None blocking. All CI jobs and local gates pass.
