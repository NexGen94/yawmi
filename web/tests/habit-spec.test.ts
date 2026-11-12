import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isScheduled } from '../src/domain/periods';
import { habitSpecOf, type HabitSpecSource } from '../src/habits/spec';
import type { HabitIn, HabitOut } from '../src/habits/types';

const stored: HabitOut = {
  code: 'u_0123456789ab',
  title_ar: 'قراءة',
  goal_ref: null,
  outcome: 'O4',
  ac_ref: null,
  kind: 'duration',
  unit: 'min',
  target_per_period: 20,
  period: 'day',
  schedule_kind: 'every_n_days',
  weekday_mask: null,
  every_n: 3,
  anchor_day: '2026-11-01',
  anchor: 'before_sleep',
  start_day: '2026-11-01',
  end_day: '2026-12-31',
  system: false,
  created_by: 'user',
  active: true,
  polarity: 'build',
  identity_text: null,
  reminders: [{ time: '21:30', days_mask: 127 }],
};

describe('habitSpecOf', () => {
  it('maps a stored habit to the rule input, field by field', () => {
    expect(habitSpecOf(stored)).toEqual({
      kind: 'duration',
      unit: 'min',
      targetPerPeriod: 20,
      period: 'day',
      scheduleKind: 'every_n_days',
      weekdayMask: null,
      everyN: 3,
      anchorDay: '2026-11-01',
      startDay: '2026-11-01',
      endDay: '2026-12-31',
    });
  });

  it('keeps the server spelling of "no unit" (the empty string)', () => {
    expect(habitSpecOf({ ...stored, kind: 'boolean', unit: '', target_per_period: 1 }).unit).toBe('');
  });

  it('gives a spec the rules accept', () => {
    const spec = habitSpecOf(stored);
    expect(isScheduled('2026-11-04', spec)).toBe(true);
    expect(isScheduled('2026-11-05', spec)).toBe(false);
  });

  it('reads a habit that is not saved yet, where the optional fields may be missing', () => {
    const unsaved: HabitIn = {
      title_ar: 'مشي',
      kind: 'count',
      unit: 'session',
      target_per_period: 3,
      period: 'week',
      schedule_kind: 'every_day',
      anchor: 'free',
      start_day: '2026-11-10',
      polarity: 'build',
    };
    expect(habitSpecOf(unsaved)).toMatchObject({
      weekdayMask: null,
      everyN: null,
      anchorDay: null,
      startDay: '2026-11-10',
      endDay: null,
    });
  });

  it('reads a missing start day as today, as the server does when it saves the habit', () => {
    const unsaved: HabitIn = {
      title_ar: 'مشي',
      kind: 'boolean',
      unit: '',
      target_per_period: 1,
      period: 'day',
      schedule_kind: 'every_day',
      anchor: 'free',
      start_day: null,
      polarity: 'build',
    };
    expect(habitSpecOf(unsaved, '2026-11-10').startDay).toBe('2026-11-10');
    expect(habitSpecOf({ ...unsaved, start_day: undefined }, '2026-11-10').startDay).toBe('2026-11-10');
  });

  it('refuses a missing start day when no today is given', () => {
    const unsaved = { ...stored, start_day: null } as unknown as HabitIn;
    expect(() => habitSpecOf(unsaved)).toThrow(RangeError);
  });

  it('refuses what the rules refuse, such as every_n = 1', () => {
    expect(() => habitSpecOf({ ...stored, every_n: 1 })).toThrow(RangeError);
    expect(() => habitSpecOf({ ...stored, end_day: '2026-10-01' })).toThrow(RangeError);
  });
});

describe('habitSpecOf on the shared vectors', () => {
  // The vectors' `habit` objects have exactly the API field names (snake_case), with `unit: null`
  // where the API says ''. Each is_scheduled case goes through habitSpecOf and must agree.
  const file = JSON.parse(
    readFileSync(new URL('../../contracts/domain-vectors/v1/is_scheduled.json', import.meta.url), 'utf8'),
  ) as { cases: { id: string; input: { day: string; habit: HabitSpecSource }; expect: { value: boolean } }[] };

  it('has cases to run', () => {
    expect(file.cases.length).toBeGreaterThan(20);
  });

  it.each(file.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(isScheduled(c.input.day, habitSpecOf(c.input.habit))).toBe(c.expect.value);
  });
});
