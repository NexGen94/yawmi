// What the shared vectors cannot carry (contracts/domain-vectors/README.md, "ما لا تغطيه
// المتجهات"): error cases, which each client tests locally, and independence from the process's
// time zone. Leap days, month ends and week starts are covered by the vectors themselves
// (day_key-007..009, period_bounds-009..023, end_day-003/008/009, is_scheduled-012..016).

import { afterEach, describe, expect, it } from 'vitest';

import { addDays, dayKey, toOrdinal } from '../src/domain/days';
import { adherence, challengeProgress, goalPrefill, periodProgress, streak, strength } from '../src/domain/habits';
import { endDay, isScheduled, periodBounds } from '../src/domain/periods';
import type { HabitLog, HabitSpec, WeekStart } from '../src/domain/types';

const daily: HabitSpec = {
  kind: 'boolean',
  unit: null,
  targetPerPeriod: 1,
  period: 'day',
  scheduleKind: 'every_day',
  weekdayMask: null,
  everyN: null,
  anchorDay: null,
  startDay: '2026-11-09',
  endDay: null,
};

const habitRules = [
  (spec: HabitSpec, logs: HabitLog[], ws: WeekStart) => periodProgress(spec, logs, '2026-11-20', ws),
  (spec: HabitSpec, logs: HabitLog[], ws: WeekStart) => strength(spec, logs, '2026-11-20', ws),
  (spec: HabitSpec, logs: HabitLog[], ws: WeekStart) => streak(spec, logs, '2026-11-20', ws),
  (spec: HabitSpec, logs: HabitLog[], ws: WeekStart) => challengeProgress(spec, logs, '2026-11-20', ws),
  (spec: HabitSpec, logs: HabitLog[], ws: WeekStart) => adherence(spec, logs, '2026-11-20', ws),
];

describe('days', () => {
  it('refuses strings that are not calendar days', () => {
    for (const bad of ['2027-02-29', '2026-13-01', '2026-11-31', '2026-1-09', '20261109', '', '2026-11-09T00:00Z']) {
      expect(() => toOrdinal(bad), bad).toThrow(RangeError);
    }
    expect(toOrdinal('1970-01-01')).toBe(0);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('refuses an instant without a zone, and an unknown tz', () => {
    expect(() => dayKey('2026-11-09T23:30:00', 'Asia/Riyadh')).toThrow(RangeError);
    expect(() => dayKey('2026-11-09', 'Asia/Riyadh')).toThrow(RangeError);
    expect(() => dayKey('not a date', 'Asia/Riyadh')).toThrow(RangeError);
    expect(() => dayKey('2026-11-09T23:30:00Z', 'Europe/London')).toThrow(RangeError);
    expect(dayKey('2026-11-09T23:30:00Z')).toBe('2026-11-10');
  });
});

describe('the browser time zone has no effect', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it.for(['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Riyadh'])('TZ=%s', (tz) => {
    process.env.TZ = tz;
    expect(dayKey('2026-11-09T21:00:00Z', 'Asia/Riyadh')).toBe('2026-11-10');
    expect(dayKey('2026-11-09T20:59:59.999Z', 'Asia/Riyadh')).toBe('2026-11-09');
    expect(periodBounds('2028-02-29', 'week', 'sun')).toEqual({ start: '2028-02-27', end: '2028-03-04' });
    expect(periodBounds('2028-02-29', 'month', 'sun')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(endDay('2026-12-30', 3)).toBe('2027-01-01');
    expect(isScheduled('2026-11-14', { ...daily, scheduleKind: 'weekdays', weekdayMask: 64 })).toBe(true);
  });
});

describe('periods', () => {
  it('refuses an unknown week start, even for a day or month period', () => {
    for (const period of ['day', 'week', 'month'] as const) {
      expect(() => periodBounds('2026-11-09', period, 'fri' as WeekStart)).toThrow(RangeError);
    }
  });

  it('refuses an unknown period', () => {
    expect(() => periodBounds('2026-11-09', 'year' as 'day', 'sun')).toThrow(RangeError);
  });

  it('refuses a challenge shorter than one whole day', () => {
    expect(() => endDay('2026-11-09', 0)).toThrow(RangeError);
    expect(() => endDay('2026-11-09', 1.5)).toThrow(RangeError);
  });
});

describe('habit specs the reference refuses', () => {
  const invalid: [string, Partial<HabitSpec>][] = [
    ['unknown kind', { kind: 'rating' as HabitSpec['kind'] }],
    ['unknown period', { period: 'year' as HabitSpec['period'] }],
    ['unknown schedule', { scheduleKind: 'monthly' as HabitSpec['scheduleKind'] }],
    ['weekly habit on weekdays', { period: 'week', scheduleKind: 'weekdays', weekdayMask: 3 }],
    ['zero target', { targetPerPeriod: 0 }],
    ['negative target', { targetPerPeriod: -1 }],
    ['NaN target', { targetPerPeriod: Number.NaN }],
    ['weekdays without a mask', { scheduleKind: 'weekdays', weekdayMask: null }],
    ['weekdays mask 0', { scheduleKind: 'weekdays', weekdayMask: 0 }],
    ['weekdays mask 128', { scheduleKind: 'weekdays', weekdayMask: 128 }],
    ['every n days with n = 0', { scheduleKind: 'every_n_days', everyN: 0, anchorDay: '2026-11-09' }],
    ['every n days without an anchor', { scheduleKind: 'every_n_days', everyN: 2, anchorDay: null }],
    ['end before start', { endDay: '2026-11-08' }],
    ['bad start day', { startDay: '2026-02-30' }],
  ];

  it.for(invalid)('%s', ([, change]) => {
    const spec = { ...daily, ...change };
    expect(() => isScheduled('2026-11-10', spec)).toThrow(RangeError);
    for (const rule of habitRules) expect(() => rule(spec, [], 'sun')).toThrow(RangeError);
  });
});

describe('habit rules', () => {
  it('refuses an unknown week start in every rule', () => {
    for (const rule of habitRules) expect(() => rule(daily, [], 'fri' as WeekStart)).toThrow(RangeError);
    expect(() => goalPrefill(10, 0, '2026-11-09', '2026-11-30', 'week', 'fri' as WeekStart)).toThrow(RangeError);
  });

  it('refuses an unknown log status', () => {
    // With an end day: for an open habit challengeProgress returns null before reading the logs,
    // as the reference does.
    const challenge = { ...daily, endDay: '2026-12-08' };
    const logs = [{ day: '2026-11-10', value: 1, status: 'partial' as HabitLog['status'] }];
    for (const rule of habitRules) expect(() => rule(challenge, logs, 'sun')).toThrow(RangeError);
  });

  it('does not mutate the logs it is given', () => {
    const logs: HabitLog[] = [
      { day: '2026-11-12', value: 1, status: 'done' },
      { day: '2026-11-10', value: null, status: 'skip' },
    ];
    const copy = structuredClone(logs);
    for (const rule of habitRules) rule(daily, logs, 'sun');
    expect(logs).toEqual(copy);
  });
});
