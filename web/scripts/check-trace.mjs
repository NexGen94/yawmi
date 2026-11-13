// The trace check: every test file that the tables of design section 2 name (the «الاختبار» column
// of 2.1, 2.2 and 2.3) must exist. The list is written here, once, so that a file renamed or
// dropped without the design being corrected fails the build instead of leaving a promise that no
// test keeps. Paths are as the design writes them: `test_*.py` under api/tests, `e2e/*.spec.ts`
// under web/e2e, every other name under web/tests.
//
//   node web/scripts/check-trace.mjs     (from the repository root, or from web/)
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');

/** Web unit and component tests (web/tests). */
export const WEB_TESTS = [
  'ai/consent.test.tsx',
  'ai/deeper.test.tsx',
  'ai/guard.test.ts',
  'breath/calc.test.ts',
  'breath/timing.test.ts',
  'budget.test.ts',
  'charts-goals.test.tsx',
  'data/events.test.ts',
  'data/pending.test.ts',
  'data/session.test.ts',
  'focus/calc.test.ts',
  'focus/timer.test.ts',
  'goals/domains.test.ts',
  'habit-form.test.ts',
  'indicators.test.tsx',
  'outbox.test.ts',
  'pages/ask.test.tsx',
  'pages/breath.test.tsx',
  'pages/day.test.tsx',
  'pages/focus.test.tsx',
  'pages/goal-detail.test.tsx',
  'pages/goals.test.tsx',
  'pages/habit-detail.test.tsx',
  'pages/habit-editor.test.tsx',
  'pages/habits-list.test.tsx',
  'pages/home-late.test.tsx',
  'pages/home.test.tsx',
  'pages/pair.test.tsx',
  'pages/review.test.tsx',
  'pages/settings-ai.test.tsx',
  'pages/settings-base.test.tsx',
  'pages/settings-profile.test.tsx',
  'progress/impact.test.ts',
  'progress/indicator.test.ts',
  'progress/state.test.ts',
  'push.test.ts',
  'review/mood-stats.test.ts',
  'shell-ui.test.tsx',
];

/** End-to-end specs (web/e2e). */
export const E2E_SPECS = [
  'ask.spec.ts',
  'evening.spec.ts',
  'goal-edit.spec.ts',
  'habit-new.spec.ts',
  'morning.spec.ts',
  'offline.spec.ts',
  'pairing.spec.ts',
];

/** Server tests (api/tests). */
export const API_TESTS = [
  'test_ai_consent.py',
  'test_ai_memory.py',
  'test_auth_logout.py',
  'test_breath_api.py',
  'test_focus_api.py',
  'test_goal_edits.py',
  'test_goal_tasks.py',
  'test_goals_pace.py',
  'test_goals_read.py',
  'test_grounding.py',
  'test_habit_logs_api.py',
  'test_habit_rules.py',
  'test_habit_state.py',
  'test_habits_api.py',
  'test_indicators_api.py',
  'test_insights_kinds.py',
  'test_journal.py',
  'test_migrations.py',
  'test_mood.py',
  'test_notices.py',
  'test_notion_port.py',
  'test_openapi.py',
  'test_settings_api.py',
  'test_today.py',
];

const expected = [
  ...WEB_TESTS.map((name) => join(root, 'web', 'tests', name)),
  ...E2E_SPECS.map((name) => join(root, 'web', 'e2e', name)),
  ...API_TESTS.map((name) => join(root, 'api', 'tests', name)),
];

const missing = expected.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error(`check-trace: ${missing.length} trace file(s) missing:`);
  for (const path of missing) console.error(`  ${relative(root, path).split(sep).join('/')}`);
  process.exit(1);
}
console.log(`كل ملفات التتبّع موجودة: ${expected.length}`);
