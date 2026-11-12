// The habit rules against the shared vectors (contracts/domain-vectors/README.md). Python is the
// reference; every case in the ten habit files must pass here unchanged. The four health files
// (baseline, recovery, strain, trimp) are out of scope for the web and are never read.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { dayKey } from '../src/domain/days';
import {
  adherence,
  challengeProgress,
  goalPrefill,
  periodProgress,
  streak,
  strength,
} from '../src/domain/habits';
import { endDay, isScheduled, periodBounds } from '../src/domain/periods';
import {
  RULES_VERSION,
  type Day,
  type HabitLog,
  type HabitSpec,
  type Period,
  type WeekStart,
} from '../src/domain/types';

interface VectorCase {
  id: string;
  input: Record<string, unknown>;
  expect: { value: unknown };
  tol?: number;
  source: string;
}

interface VectorFile {
  rulesVersion: number;
  function: string;
  cases: VectorCase[];
}

interface HabitInput {
  habit: HabitSpec;
  logs: HabitLog[];
  today: Day;
  weekStart: WeekStart;
}

const VECTOR_DIR = new URL('../../contracts/domain-vectors/v1/', import.meta.url);
const DEFAULT_TOL = 1e-9;

// Per file: how to call the TypeScript rule with the camelCased input, and which result fields
// are fractions (compared with a tolerance). Every other number is compared exactly. The key ''
// is the result itself when it is a bare number.
const RUNNERS = {
  day_key: { floats: [], run: (i: { instant: string; tz: string }) => dayKey(i.instant, i.tz) },
  period_bounds: {
    floats: [],
    run: (i: { day: Day; period: Period; weekStart: WeekStart }) =>
      periodBounds(i.day, i.period, i.weekStart),
  },
  is_scheduled: { floats: [], run: (i: { day: Day; habit: HabitSpec }) => isScheduled(i.day, i.habit) },
  end_day: { floats: [], run: (i: { start: Day; durationDays: number }) => endDay(i.start, i.durationDays) },
  period_progress: {
    floats: ['done', 'target', 'completion', 'expected', 'needPerDay'],
    run: (i: HabitInput) => periodProgress(i.habit, i.logs, i.today, i.weekStart),
  },
  strength: { floats: [''], run: (i: HabitInput) => strength(i.habit, i.logs, i.today, i.weekStart) },
  streak: { floats: [], run: (i: HabitInput) => streak(i.habit, i.logs, i.today, i.weekStart) },
  challenge_progress: {
    floats: ['completion'],
    run: (i: HabitInput) => challengeProgress(i.habit, i.logs, i.today, i.weekStart),
  },
  adherence: { floats: [''], run: (i: HabitInput) => adherence(i.habit, i.logs, i.today, i.weekStart) },
  goal_prefill: {
    floats: [],
    run: (i: {
      goalTarget: number;
      current: number;
      today: Day;
      deadline: Day;
      period: Period;
      weekStart: WeekStart;
    }) => goalPrefill(i.goalTarget, i.current, i.today, i.deadline, i.period, i.weekStart),
  },
} satisfies Record<string, { floats: string[]; run: (input: never) => unknown }>;

type FunctionName = keyof typeof RUNNERS;
const FUNCTIONS = Object.keys(RUNNERS) as FunctionName[];

// The exact input keys of each file, as written (snake_case). A field the runner does not know
// would otherwise be ignored silently, so an unknown or missing key fails the case.
const HABIT_INPUT = ['habit', 'logs', 'today', 'week_start'];
const INPUT_KEYS: Record<FunctionName, readonly string[]> = {
  day_key: ['instant', 'tz'],
  period_bounds: ['day', 'period', 'week_start'],
  is_scheduled: ['day', 'habit'],
  end_day: ['start', 'duration_days'],
  period_progress: HABIT_INPUT,
  strength: HABIT_INPUT,
  streak: HABIT_INPUT,
  challenge_progress: HABIT_INPUT,
  adherence: HABIT_INPUT,
  goal_prefill: ['goal_target', 'current', 'today', 'deadline', 'period', 'week_start'],
};
const HABIT_KEYS = [
  'kind',
  'unit',
  'target_per_period',
  'period',
  'schedule_kind',
  'weekday_mask',
  'every_n',
  'anchor_day',
  'start_day',
  'end_day',
];
// rulesVersion 2: `polarity` is present in the twenty abstain cases only; missing means 'build'.
const OPTIONAL_HABIT_KEYS = ['polarity'];
const LOG_KEYS = ['day', 'value', 'status'];

const sortedKeys = (value: unknown): string[] => Object.keys(value as object).sort();

function expectInputKeys(name: FunctionName, input: Record<string, unknown>): void {
  expect(sortedKeys(input), 'input keys').toEqual([...INPUT_KEYS[name]].sort());
  if ('habit' in input) {
    const keys = sortedKeys(input.habit);
    const optional = keys.filter((key) => OPTIONAL_HABIT_KEYS.includes(key));
    expect(keys, 'habit keys').toEqual([...HABIT_KEYS, ...optional].sort());
  }
  if ('logs' in input) {
    for (const log of input.logs as unknown[]) expect(sortedKeys(log), 'log keys').toEqual([...LOG_KEYS].sort());
  }
}

const vectorPath = (name: string): string => fileURLToPath(new URL(`${name}.json`, VECTOR_DIR));

/** The file, or `undefined` when it is missing; the "files" test below then fails by name. */
function load(name: string): VectorFile | undefined {
  const path = vectorPath(name);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as VectorFile;
}

const FILES = new Map(FUNCTIONS.map((name) => [name, load(name)] as const));

const camel = (key: string): string => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** snake_case keys to camelCase, recursively; values are left as they are. */
function toCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamel);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [camel(key), toCamel(inner)]));
  }
  return value;
}

/** The comparison rules of the README: fractions within `tol`, everything else exact. */
function expectMatch(actual: unknown, expected: unknown, floats: readonly string[], tol: number, path = ''): void {
  if (expected === null) {
    expect(actual, path || 'value').toBeNull();
  } else if (typeof expected === 'number') {
    expect(typeof actual, path || 'value').toBe('number');
    if (floats.includes(path)) {
      expect(Math.abs((actual as number) - expected), path || 'value').toBeLessThanOrEqual(tol);
    } else {
      expect(Number.isInteger(expected), `${path || 'value'} is an integer field`).toBe(true);
      expect(actual, path || 'value').toBe(expected);
    }
  } else if (typeof expected === 'object') {
    expect(actual, path || 'value').toBeTypeOf('object');
    expect(actual, path || 'value').not.toBeNull();
    const record = actual as Record<string, unknown>;
    expect(Object.keys(record).sort(), `keys of ${path || 'value'}`).toEqual(Object.keys(expected).sort());
    for (const [key, inner] of Object.entries(expected)) {
      expectMatch(record[key], inner, floats, tol, key);
    }
  } else {
    expect(actual, path || 'value').toBe(expected);
  }
}

describe('vector files', () => {
  test.for(FUNCTIONS)('%s.json exists, matches the rules version and has cases', (name) => {
    const file = FILES.get(name);
    expect(file, `${vectorPath(name)} is missing`).toBeDefined();
    expect(file?.function).toBe(name);
    expect(
      file?.rulesVersion,
      `${name}.json is at rulesVersion ${String(file?.rulesVersion)} but the web port implements ` +
        `${RULES_VERSION}: re-port the changed rules from api/yawmi/domain into web/src/domain, ` +
        'then raise RULES_VERSION in web/src/domain/types.ts',
    ).toBe(RULES_VERSION);
    expect(file?.cases.length ?? 0).toBeGreaterThan(0);
    for (const c of file?.cases ?? []) expect(c.id.startsWith(`${name}-`), c.id).toBe(true);
  });
});

for (const name of FUNCTIONS) {
  const runner = RUNNERS[name];
  describe(name, () => {
    test.for(FILES.get(name)?.cases ?? [])('$id', (c) => {
      expectInputKeys(name, c.input);
      const input = toCamel(c.input) as never;
      const expected = toCamel(c.expect.value);
      expectMatch(runner.run(input), expected, runner.floats, c.tol ?? DEFAULT_TOL);
    });
  });
}

describe('rulesVersion 2', () => {
  test('the habit files hold the 312 v1 cases and four abstain cases per affected function', () => {
    const abstain = ['clean', 'slip-mid', 'slip-today', 'skip-neutral'];
    const counts: Partial<Record<FunctionName, number>> = {
      period_progress: 45,
      strength: 39,
      streak: 34,
      challenge_progress: 24,
      adherence: 26,
    };
    for (const [name, count] of Object.entries(counts) as [FunctionName, number][]) {
      const ids = (FILES.get(name)?.cases ?? []).map((c) => c.id);
      expect(ids.length, name).toBe(count);
      for (const suffix of abstain) expect(ids, name).toContain(`${name}-abstain-${suffix}`);
    }
  });
});
