-- 0003_yawmi_web.sql: the desktop web round (ten tables, four columns, one view).
--
-- Requires: 0001 (schema yawmi) and 0002 (role yawmi_api), and the Raqib mirror table
-- raqib.notion_cards (W9). Run as the database admin: it creates a view over a table in raqib
-- and the view runs with its owner's rights.
--
-- Unlike 0001 this file grants to yawmi_api itself (0002 only grants on the tables that
-- existed when it ran, and re-running 0002 resets every grant in schema yawmi; if 0002 is
-- ever re-applied, loader 3 re-asserts this file's GRANT section). Least privilege:
--   * SELECT, INSERT, UPDATE on the ten new tables; DELETE only on ai_memory and indicators.
--   * USAGE on schema yawmi_ro and SELECT on the view yawmi_ro.notion_card_fields. Nothing
--     new on schema raqib: the column
--     raqib.notion_cards.props stays unreadable for yawmi_api, and the view exposes two named
--     keys of it (the target date and the next step), never any other key.
--
-- WHY THE VIEW LIVES IN ITS OWN SCHEMA: a one-table view is updatable, and 0002 grants
-- INSERT and UPDATE on every relation in schema yawmi (views included) each time it is
-- applied. In yawmi_ro nothing but this file's SELECT grant ever reaches yawmi_api.
-- RE-APPLYING 0002 resets all grants in schema yawmi, including the ones below on the
-- ten tables (DELETE on ai_memory and indicators in particular). Loader 3 re-asserts
-- the GRANT section (everything from the line REVOKE ALL ON ALL TABLES IN SCHEMA yawmi_ro
-- on) on every
-- run, so loader 3 must run after any re-application of loader 2.
--
-- Same recording rule as 0001: the runner records every applied file in
-- yawmi.schema_migrations; a psql loader must do the same:
--   INSERT INTO yawmi.schema_migrations (filename) VALUES ('0003_yawmi_web.sql')
--   ON CONFLICT DO NOTHING;
-- Conventions as in 0001: timestamptz always, never serial, the local day is Asia/Riyadh,
-- weekday masks use bit 0 = Sunday ... bit 6 = Saturday (1..127).

BEGIN;

SET client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- New columns on existing tables
-- ---------------------------------------------------------------------------

ALTER TABLE yawmi.habits
ADD COLUMN polarity text NOT NULL DEFAULT 'build' CHECK (polarity IN ('build', 'abstain')),
ADD COLUMN identity_text text CHECK (char_length(identity_text) <= 300),
ADD CONSTRAINT habits_abstain_daily_boolean_chk
CHECK (polarity = 'build' OR (kind = 'boolean' AND period = 'day' AND target_per_period = 1));

ALTER TABLE yawmi.breath_sessions
ADD COLUMN feeling text CHECK (feeling IN ('calmer', 'same', 'tense'));

ALTER TABLE yawmi.ai_insights
ADD COLUMN cards jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cards) = 'array');

-- ---------------------------------------------------------------------------
-- Settings and AI consent and memory
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.user_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Withdrawal sets revoked_at; the row is never deleted.
CREATE TABLE yawmi.ai_consents (
  provider text PRIMARY KEY,
  personal_text boolean NOT NULL DEFAULT FALSE,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  device_id uuid REFERENCES yawmi.devices
);

CREATE TABLE yawmi.ai_memory (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('rule', 'note')),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 300),
  active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Journal and mood
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.journal_entries (
  day date NOT NULL,
  part text NOT NULL CHECK (part IN ('morning', 'evening')),
  answers jsonb NOT NULL,
  event_id uuid REFERENCES yawmi.events,
  logged_at timestamptz NOT NULL,
  PRIMARY KEY (day, part)
);

CREATE TABLE yawmi.mood_logs (
  day date PRIMARY KEY,
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  feelings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(feelings) = 'array'),
  activities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(activities) = 'array'),
  event_id uuid,
  logged_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- Goals: tasks and the pending-edit layer over the Notion mirror
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.goal_tasks (
  id uuid PRIMARY KEY,
  goal_ref text NOT NULL,
  title text NOT NULL,
  due_day date,
  done_at timestamptz,
  done_logged_at timestamptz,
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX goal_tasks_goal_ref_idx ON yawmi.goal_tasks (goal_ref);

CREATE TABLE yawmi.goal_edits (
  id uuid PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('milestone', 'card')),
  page_id text NOT NULL,
  field text NOT NULL,
  old_value jsonb,
  new_value jsonb NOT NULL,
  note text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'applied', 'failed', 'superseded', 'conflict')),
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  error text
);

-- At most one pending edit per page and field.
CREATE UNIQUE INDEX goal_edits_one_pending_idx ON yawmi.goal_edits (page_id, field)
WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Indicators, focus plans, notices
-- ---------------------------------------------------------------------------

CREATE TABLE yawmi.indicators (
  id uuid PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('habit', 'goal')),
  subject_ref text NOT NULL,
  title_ar text,
  source text NOT NULL CHECK (source IN ('habit_logs', 'linked_habits', 'milestones', 'tasks')),
  measure text NOT NULL
  CHECK (measure IN ('completion', 'total', 'avg_7d', 'avg_30d', 'strength')),
  target numeric CHECK (target > 0),
  period text NOT NULL CHECK (period IN ('day', 'week', 'month', 'cycle', 'all')),
  display text NOT NULL CHECK (display IN ('ring', 'bar', 'number', 'sparkline')),
  reminder_time time,
  reminder_mask smallint CHECK (reminder_mask BETWEEN 1 AND 127),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_ref),
  CONSTRAINT indicators_subject_shape_chk CHECK (
    (
      subject_kind = 'habit' AND source = 'habit_logs'
      AND reminder_time IS NULL AND reminder_mask IS NULL
    )
    OR (
      subject_kind = 'goal' AND source IN ('linked_habits', 'milestones', 'tasks')
      AND measure = 'completion'
    )
  ),
  CONSTRAINT indicators_reminder_pair_chk CHECK ((reminder_time IS NULL) = (reminder_mask IS NULL))
);

CREATE TABLE yawmi.focus_plans (
  id uuid PRIMARY KEY,
  title_ar text NOT NULL,
  minutes smallint NOT NULL CHECK (minutes BETWEEN 5 AND 240),
  goal_ref text,
  habit_code text REFERENCES yawmi.habits,
  favorite boolean NOT NULL DEFAULT FALSE,
  weekday_mask smallint CHECK (weekday_mask BETWEEN 1 AND 127),
  start_time time,
  active boolean NOT NULL DEFAULT TRUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT focus_plans_mask_and_time_chk CHECK ((weekday_mask IS NULL) = (start_time IS NULL))
);

-- One send per kind, reference and local day: no repeat after a restart.
CREATE TABLE yawmi.notice_sends (
  kind text NOT NULL,
  ref text NOT NULL,
  day date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref, day)
);

-- ---------------------------------------------------------------------------
-- The one window onto raqib.notion_cards.props: two named keys, nothing else.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS yawmi_ro;

CREATE VIEW yawmi_ro.notion_card_fields WITH (security_invoker = FALSE) AS
SELECT
  page_id,
  CASE jsonb_typeof(props -> 'المستهدف')
    WHEN 'object' THEN props -> 'المستهدف' ->> 'start'
    WHEN 'string' THEN props ->> 'المستهدف'
  END AS target_date,
  props ->> 'الخطوة التالية' AS next_step
FROM raqib.notion_cards;

-- ---------------------------------------------------------------------------
-- Grants (idempotent; loader 3 runs this section alone on every run)
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA yawmi_ro FROM yawmi_api;
REVOKE ALL ON SCHEMA yawmi_ro FROM yawmi_api;
GRANT USAGE ON SCHEMA yawmi_ro TO yawmi_api;
GRANT SELECT ON yawmi_ro.notion_card_fields TO yawmi_api;
REVOKE ALL ON
yawmi.user_settings,
yawmi.ai_consents,
yawmi.ai_memory,
yawmi.journal_entries,
yawmi.mood_logs,
yawmi.goal_tasks,
yawmi.goal_edits,
yawmi.indicators,
yawmi.focus_plans,
yawmi.notice_sends
FROM yawmi_api;
GRANT SELECT, INSERT, UPDATE ON
yawmi.user_settings,
yawmi.ai_consents,
yawmi.ai_memory,
yawmi.journal_entries,
yawmi.mood_logs,
yawmi.goal_tasks,
yawmi.goal_edits,
yawmi.indicators,
yawmi.focus_plans,
yawmi.notice_sends
TO yawmi_api;
GRANT DELETE ON yawmi.ai_memory, yawmi.indicators TO yawmi_api;

COMMIT;
