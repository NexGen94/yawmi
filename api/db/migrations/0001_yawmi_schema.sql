-- 0001_yawmi_schema.sql: the yawmi schema (thirteen tables).
--
-- Lives in the raqib database next to the Raqib mirror (schema raqib). Conventions:
--   * timestamptz always, never serial; event ids are UUIDv7 minted by the client.
--   * the local day is Asia/Riyadh (UTC+3, no DST); the week starts on Sunday.
--   * weekday masks: bit 0 = Sunday ... bit 6 = Saturday (1..127, 127 = every day).
--   * habits are editable data, not code: schedule, anchor and reminders live here.
--   * tables are only created here; grants to yawmi_api are in 0002. A later migration
--     that adds a table must grant to yawmi_api itself.
-- The runner wraps this file in one transaction and records it in
-- yawmi.schema_migrations; BEGIN/COMMIT below also let it run standalone under psql.
-- This file also creates yawmi.schema_migrations (IF NOT EXISTS, same DDL as the runner's
-- bootstrap), so 0002 can reference it even when the runner is not used. A psql loader must
-- then record each file it applies:
--   INSERT INTO yawmi.schema_migrations (filename) VALUES ('0001_yawmi_schema.sql')
--   ON CONFLICT DO NOTHING;

BEGIN;

CREATE SCHEMA IF NOT EXISTS yawmi;

-- Migration ledger. Identical to the runner's bootstrap so either path may create it first.
CREATE TABLE IF NOT EXISTS yawmi.schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Devices and pairing
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.devices (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  kind text CHECK (kind IN ('iphone', 'watch', 'web', 'service')),
  refresh_hash text,
  paired_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE yawmi.pairing_codes (
  code text PRIMARY KEY,
  kind text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Events: append-only, idempotent on id (INSERT ... ON CONFLICT (id) DO NOTHING)
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.events (
  id uuid PRIMARY KEY,
  device_id uuid REFERENCES yawmi.devices,
  type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  tz text NOT NULL DEFAULT 'Asia/Riyadh',
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_occurred_at_idx ON yawmi.events (occurred_at);
CREATE INDEX events_type_occurred_at_idx ON yawmi.events (type, occurred_at);
-- GET /v1/events?since= pages by receipt time.
CREATE INDEX events_received_at_idx ON yawmi.events (received_at, id);

-- ---------------------------------------------------------------------------
-- Habits, reminders, logs
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.habits (
  code text PRIMARY KEY,
  title_ar text NOT NULL,
  goal_ref text,
  outcome text CHECK (outcome ~ '^O([1-9]|1[0-2])$'),
  ac_ref text,
  kind text NOT NULL CHECK (kind IN ('boolean', 'count', 'duration')),
  unit text CHECK (unit IN ('session', 'min', 'hour')),
  target_per_period numeric NOT NULL CHECK (target_per_period > 0),
  period text NOT NULL CHECK (period IN ('day', 'week', 'month')),
  schedule_kind text NOT NULL DEFAULT 'every_day'
  CHECK (schedule_kind IN ('every_day', 'weekdays', 'every_n_days')),
  weekday_mask smallint CHECK (weekday_mask BETWEEN 1 AND 127),
  every_n smallint CHECK (every_n >= 2),
  anchor_day date,
  anchor text CHECK (anchor IN ('after_wake', 'before_sleep', 'free')),
  start_day date NOT NULL,
  end_day date,
  system boolean NOT NULL DEFAULT FALSE,
  created_by text NOT NULL CHECK (created_by IN ('seed', 'user')),
  active boolean NOT NULL DEFAULT TRUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT habits_period_schedule_chk
  CHECK (period = 'day' OR schedule_kind = 'every_day'),
  CONSTRAINT habits_weekdays_mask_chk
  CHECK (schedule_kind <> 'weekdays' OR weekday_mask IS NOT NULL),
  CONSTRAINT habits_every_n_anchor_chk
  CHECK (schedule_kind <> 'every_n_days' OR (every_n IS NOT NULL AND anchor_day IS NOT NULL)),
  CONSTRAINT habits_end_after_start_chk
  CHECK (end_day IS NULL OR end_day >= start_day)
);

COMMENT ON COLUMN yawmi.habits.weekday_mask IS
'Scheduled weekdays when schedule_kind = weekdays: bit 0 = Sunday ... bit 6 = Saturday.';
COMMENT ON COLUMN yawmi.habits.anchor IS
'Execution cue (after waking, before sleep, free); not the every-N-days anchor.';
COMMENT ON COLUMN yawmi.habits.anchor_day IS
'Reference day for schedule_kind = every_n_days: due on anchor_day + k * every_n.';
COMMENT ON COLUMN yawmi.habits.system IS
'Seeded from GOAL-2031.md: only anchor and reminders are editable on these.';

-- At most three reminders per habit: enforced by the service, not here.
CREATE TABLE yawmi.habit_reminders (
  id uuid PRIMARY KEY,
  habit_code text NOT NULL REFERENCES yawmi.habits,
  at_time time NOT NULL,
  weekday_mask smallint NOT NULL DEFAULT 127 CHECK (weekday_mask BETWEEN 1 AND 127),
  active boolean NOT NULL DEFAULT TRUE
);

CREATE INDEX habit_reminders_habit_code_idx ON yawmi.habit_reminders (habit_code);

CREATE TABLE yawmi.habit_logs (
  id uuid PRIMARY KEY,
  habit_code text NOT NULL REFERENCES yawmi.habits,
  day date NOT NULL,
  value numeric,
  status text CHECK (status IN ('done', 'skip', 'vacation', 'missed')),
  source text NOT NULL,
  event_id uuid REFERENCES yawmi.events,
  logged_at timestamptz NOT NULL,
  UNIQUE (habit_code, day, source)
);

CREATE INDEX habit_logs_day_idx ON yawmi.habit_logs (day);

-- ---------------------------------------------------------------------------
-- Web Push
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.push_subscriptions (
  endpoint text PRIMARY KEY,
  device_id uuid REFERENCES yawmi.devices,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  retry_after timestamptz
);

CREATE INDEX push_subscriptions_device_id_idx ON yawmi.push_subscriptions (device_id);

-- One row per reminder and local day: stops repeats after a service restart.
CREATE TABLE yawmi.reminder_sends (
  reminder_id uuid REFERENCES yawmi.habit_reminders,
  day date,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reminder_id, day)
);

-- ---------------------------------------------------------------------------
-- Health: daily metrics (one user, so no user_id)
-- Raw columns are nullable: a day without the watch is "missing data", never zero.
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.daily_metrics (
  day date PRIMARY KEY,
  hrv_ms numeric CHECK (hrv_ms >= 0),
  hrv_rmssd_ms numeric CHECK (hrv_rmssd_ms >= 0),
  rhr_bpm numeric CHECK (rhr_bpm > 0),
  sleeping_hr_bpm numeric CHECK (sleeping_hr_bpm > 0),
  walking_hr_bpm numeric CHECK (walking_hr_bpm > 0),
  resp_rate_bpm numeric CHECK (resp_rate_bpm >= 0),
  wrist_temp_delta_c numeric,
  spo2_pct numeric CHECK (spo2_pct BETWEEN 0 AND 100),
  sleep_minutes integer CHECK (sleep_minutes >= 0),
  sleep_core_minutes integer CHECK (sleep_core_minutes >= 0),
  sleep_deep_minutes integer CHECK (sleep_deep_minutes >= 0),
  sleep_rem_minutes integer CHECK (sleep_rem_minutes >= 0),
  sleep_awake_minutes integer CHECK (sleep_awake_minutes >= 0),
  in_bed_minutes integer CHECK (in_bed_minutes >= 0),
  sleep_start timestamptz,
  sleep_end timestamptz,
  steps integer CHECK (steps >= 0),
  active_kcal numeric CHECK (active_kcal >= 0),
  exercise_minutes integer CHECK (exercise_minutes >= 0),
  mindful_minutes integer CHECK (mindful_minutes >= 0),
  recovery_score smallint CHECK (recovery_score BETWEEN 0 AND 100),
  strain_score numeric(4, 1) CHECK (strain_score BETWEEN 0 AND 21),
  sleep_score smallint CHECK (sleep_score BETWEEN 0 AND 100),
  stress_score smallint CHECK (stress_score BETWEEN 0 AND 100),
  data_quality text NOT NULL DEFAULT 'missing' CHECK (data_quality IN ('missing', 'low', 'ok')),
  computed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN yawmi.daily_metrics.hrv_ms IS
'Nightly HRV as SDNN (HealthKit exposes SDNN only on this watch).';
COMMENT ON COLUMN yawmi.daily_metrics.strain_score IS
'Saturating exertion curve 0..21; the other three scores are 0..100.';
COMMENT ON COLUMN yawmi.daily_metrics.data_quality IS
'Overall label for the day: missing (no watch data), low, or ok; never used to invent zeros.';

-- ---------------------------------------------------------------------------
-- Focus and breathing sessions (projected from focus_ended / breath_ended events)
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.focus_sessions (
  id uuid PRIMARY KEY,
  device_id uuid REFERENCES yawmi.devices,
  habit_code text REFERENCES yawmi.habits,
  goal_ref text,
  day date NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  planned_minutes integer CHECK (planned_minutes > 0),
  actual_minutes numeric CHECK (actual_minutes >= 0),
  focus_rating smallint CHECK (focus_rating BETWEEN 1 AND 5),
  next_step text,
  event_id uuid REFERENCES yawmi.events,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX focus_sessions_day_idx ON yawmi.focus_sessions (day);

CREATE TABLE yawmi.breath_sessions (
  id uuid PRIMARY KEY,
  device_id uuid REFERENCES yawmi.devices,
  day date NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  pattern text NOT NULL,
  breaths_per_min numeric CHECK (breaths_per_min > 0),
  duration_seconds integer CHECK (duration_seconds >= 0),
  completed boolean NOT NULL DEFAULT TRUE,
  event_id uuid REFERENCES yawmi.events,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX breath_sessions_day_idx ON yawmi.breath_sessions (day);

-- ---------------------------------------------------------------------------
-- AI insights: only grounded, schema-validated output is stored (two lines at most,
-- three priorities at most). request_hash identifies the request; no request or
-- response body is logged anywhere else.
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.ai_insights (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  day date NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  request_hash text NOT NULL,
  lines jsonb NOT NULL
  CHECK (
    CASE WHEN jsonb_typeof(lines) = 'array' THEN jsonb_array_length(lines) <= 2 ELSE FALSE END
  ),
  question text,
  source_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_ids) = 'array'),
  priorities jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (
    CASE
      WHEN jsonb_typeof(priorities) = 'array' THEN jsonb_array_length(priorities) <= 3
      ELSE FALSE
    END
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_insights_kind_day_idx ON yawmi.ai_insights (kind, day);

-- ---------------------------------------------------------------------------
-- Sync cursors: where each device is in each pull stream
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.sync_cursor (
  device_id uuid NOT NULL REFERENCES yawmi.devices,
  stream text NOT NULL,
  cursor_at timestamptz,
  cursor_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, stream)
);

COMMIT;
