-- 0002_yawmi_role.sql: the yawmi_api role and its grants.
--
-- Pattern: raqib/server/raqib_notion_sync.proposed.sql (create the role only if missing,
-- REVOKE before GRANT so re-applying never leaves a stale grant behind).
--
-- Requires: 0001 (schema yawmi, including yawmi.schema_migrations) and the Raqib mirror in
-- schema raqib (W9 tables, goals, cycles, kpis, kpi_readings, v_journal_daily). Run as the
-- database admin: it creates a role and grants on objects it owns.
--
-- Without the Python runner (psql loader): the runner records every applied file in
-- yawmi.schema_migrations; a psql loader must do the same for each file it applies, e.g.
--   INSERT INTO yawmi.schema_migrations (filename) VALUES ('0002_yawmi_role.sql')
--   ON CONFLICT DO NOTHING;
-- (and the same for 0001), otherwise a later Python run would apply them a second time.
--
-- THE PASSWORD IS NEVER WRITTEN IN THIS FILE. The loader generates it on the server into
-- the yawmi_secrets volume and the file reads it from a transaction-local setting:
--
--   yawmi_migrate.yawmi_api_pw    <- content of /run/yawmi/yawmi_api_pw
--
-- Two equivalent ways for the loader to supply it:
--   (a) Python runner: migrate(dsn, {"yawmi_api_pw": <content of the file>}). The runner
--       binds the value as a query parameter of set_config(..., true); it is never spliced
--       into SQL text and disappears when the transaction ends. The runner strips trailing
--       whitespace (newline included) from every value, so a file read as text behaves like
--       psql's backtick: a password must not end in whitespace.
--   (b) psql, with the file content read inside the loader container:
--         \set yawmi_api_pw `cat /run/yawmi/yawmi_api_pw`
--         SELECT set_config('yawmi_migrate.yawmi_api_pw', :'yawmi_api_pw', false);
--         \i 0002_yawmi_role.sql
--         RESET yawmi_migrate.yawmi_api_pw;
--         \unset yawmi_api_pw
-- With no value supplied the role is still created (and grants applied) but has no
-- password, so no network login is accepted until one is set; an existing password is
-- left untouched. This file is applied once. To rotate the password later, the loader
-- runs the same set_config + the DO block below, or: ALTER ROLE yawmi_api PASSWORD :'pw'.
--
-- Privileges (least privilege):
--   * yawmi: SELECT, INSERT, UPDATE on every table; DELETE only on pairing_codes and
--     push_subscriptions. Never CREATE, TRUNCATE, or anything on yawmi.schema_migrations.
--   * raqib: SELECT only. Table-level on notion_milestones, goals, cycles, kpis and
--     v_journal_daily (a counts-only view that runs with its owner's rights). Column-level on
--     notion_cards (every column except props, which may hold personal text such as the deep
--     reason) and kpi_readings (every column except note, free text). Same precedent as
--     raqib/server/raqib_notion_sync.proposed.sql. Consequence: SELECT * on those two tables
--     is denied; name the columns. A column added to either table later is NOT readable
--     until a migration grants it. Nothing else in raqib is visible.
-- A later migration that adds a table to yawmi must GRANT to yawmi_api itself.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yawmi_api') THEN
    CREATE ROLE yawmi_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      NOBYPASSRLS CONNECTION LIMIT 5;
  END IF;
END
$$;

-- Enforced again so a role that pre-existed cannot keep wider attributes.
ALTER ROLE yawmi_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS CONNECTION LIMIT 5;
ALTER ROLE yawmi_api SET search_path = yawmi;
ALTER ROLE yawmi_api SET statement_timeout = '30s';
ALTER ROLE yawmi_api SET idle_in_transaction_session_timeout = '60s';

-- Password: only when the loader supplied one (see the header).
DO $$
DECLARE
  supplied text := nullif(current_setting('yawmi_migrate.yawmi_api_pw', true), '');
BEGIN
  IF supplied IS NULL THEN
    RAISE NOTICE 'yawmi_api: no password supplied; the role cannot log in over the network yet';
  ELSE
    EXECUTE format('ALTER ROLE yawmi_api PASSWORD %L', supplied);
  END IF;
END
$$;

-- Reset: nothing granted before this point survives.
REVOKE ALL ON ALL TABLES IN SCHEMA yawmi FROM yawmi_api;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA yawmi FROM yawmi_api;
REVOKE ALL ON SCHEMA yawmi FROM yawmi_api;
REVOKE ALL ON ALL TABLES IN SCHEMA raqib FROM yawmi_api;
REVOKE ALL ON SCHEMA raqib FROM yawmi_api;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO yawmi_api', current_database());
END
$$;

-- yawmi: read and write everything except the migration ledger; delete in two tables only.
GRANT USAGE ON SCHEMA yawmi TO yawmi_api;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA yawmi TO yawmi_api;
REVOKE ALL ON yawmi.schema_migrations FROM yawmi_api;
GRANT DELETE ON yawmi.pairing_codes, yawmi.push_subscriptions TO yawmi_api;

-- raqib: read-only mirror.
GRANT USAGE ON SCHEMA raqib TO yawmi_api;
GRANT SELECT ON
raqib.notion_milestones,
raqib.goals,
raqib.cycles,
raqib.kpis,
raqib.v_journal_daily
TO yawmi_api;
-- Column-level: every column except notion_cards.props and kpi_readings.note.
GRANT SELECT (
  page_id, title, status, outcome_codes, notion_edited_at, first_seen_at, synced_at
) ON raqib.notion_cards TO yawmi_api;
GRANT SELECT (
  id, kpi_code, reading_date, value, source, created_at
) ON raqib.kpi_readings TO yawmi_api;

COMMIT;
