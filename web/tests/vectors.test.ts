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
    expect(file?.rulesVersion).toBe(RULES_VERSION);
    expect(file?.cases.length ?? 0).toBeGreaterThan(0);
    for (const c of file?.cases ?? []) expect(c.id.startsWith(`${name}-`), c.id).toBe(true);
  });
});

for (const name of FUNCTIONS) {
  const runner = RUNNERS[name];
  describe(name, () => {
    test.for(FILES.get(name)?.cases ?? [])('$id', (c) => {
      const input = toCamel(c.input) as never;
      const expected = toCamel(c.expect.value);
      expectMatch(runner.run(input), expected, runner.floats, c.tol ?? DEFAULT_TOL);
    });
  });
}
