import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { HabitLog, WeekStart } from '../../src/domain/types';
import {
  countByFilter,
  habitState,
  matchesFilter,
  type HabitState,
  type HabitStateInput,
  type StatusFilterValue,
} from '../../src/progress/state';

interface Case {
  id: string;
  habit: HabitStateInput;
  logs: HabitLog[];
  today: string;
  week_start: WeekStart;
  expect: HabitState;
}

// The same file `api/tests/test_habit_state.py` reads: the server and the browser cannot drift.
const file = JSON.parse(
  readFileSync(new URL('../../../contracts/view-cases/habit_state.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

describe('habitState on the shared cases', () => {
  it('has the nine cases', () => {
    expect(file.cases).toHaveLength(9);
  });

  it.for(file.cases.map((c) => [c.id, c] as const))('%s', ([, c]) => {
    expect(habitState(c.habit, c.logs, c.today, c.week_start)).toBe(c.expect);
  });
});

describe('habitState: the order of the rules', () => {
  const base = file.cases.find((c) => c.id === 'S1') as Case;

  it('an inactive habit is archived whatever else holds', () => {
    expect(habitState({ ...base.habit, active: false, start_day: '2026-12-01' }, [], base.today, 'sun')).toBe('archived');
  });

  it('a habit that has not started is upcoming before it is ended', () => {
    expect(habitState({ ...base.habit, start_day: '2026-11-15', end_day: '2026-11-20' }, [], base.today, 'sun')).toBe('upcoming');
  });

  it('an abstain habit is never done: a clean day is active, not reached', () => {
    const abstain = { ...base.habit, polarity: 'abstain' as const };
    expect(habitState(abstain, [], base.today, 'sun')).toBe('active');
  });

  it('a full HabitOut is a valid input (extra fields are ignored)', () => {
    const out = { ...base.habit, code: 'x', title_ar: 'س', anchor: 'free', reminders: [] } as HabitStateInput;
    expect(habitState(out, base.logs, base.today, 'sun')).toBe('active');
  });
});

describe('the status filter', () => {
  const all: HabitState[] = ['archived', 'upcoming', 'ended', 'done', 'late', 'active'];
  const matching = (filter: StatusFilterValue): HabitState[] => all.filter((s) => matchesFilter(s, filter));

  it('«فعّالة» is active alone', () => {
    expect(matching('active')).toEqual(['active']);
  });

  it('«منجزة» is done and ended', () => {
    expect(matching('done')).toEqual(['ended', 'done']);
  });

  it('«متأخرة» is late alone', () => {
    expect(matching('late')).toEqual(['late']);
  });

  it('«الكل» is all six, so upcoming and archived match only it', () => {
    expect(matching('all')).toEqual(all);
    for (const filter of ['active', 'done', 'late'] as const) {
      expect(matchesFilter('upcoming', filter)).toBe(false);
      expect(matchesFilter('archived', filter)).toBe(false);
    }
  });

  it('counts each chip', () => {
    expect(countByFilter(['active', 'late', 'late', 'done', 'ended', 'upcoming', 'archived'])).toEqual({
      active: 1,
      done: 2,
      late: 2,
      all: 7,
    });
    expect(countByFilter([])).toEqual({ active: 0, done: 0, late: 0, all: 0 });
  });
});
