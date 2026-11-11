// What the shared vectors cannot carry (contracts/domain-vectors/README.md, "ما لا تغطيه
// المتجهات"): error cases, which each client tests locally, and independence from the process's
// time zone. Leap days, month ends and week starts are covered by the vectors themselves
// (day_key-007..009, period_bounds-009..023, end_day-003/008/009, is_scheduled-012..016).

import { afterEach, describe, expect, it } from 'vitest';

import { dayKey, toOrdinal } from '../src/domain/days';
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
  });

  it('refuses an instant without a zone, and an unknown tz', () => {
    expect(() => dayKey('2026-11-09T23:30:00', 'Asia/Riyadh')).toThrow(RangeError);
    expect(() => dayKey('2026-11-09', 'Asia/Riyadh')).toThrow(RangeError);
    expect(() => dayKey('not a date', 'Asia/Riyadh')).toThrow(RangeError);
    expect(() => dayKey('2026-11-09T23:30:00Z', 'Europe/London')).toThrow(RangeError);
  });

  it('has no default tz: the zone is always passed', () => {
    // @ts-expect-error tz is required
    expect(() => dayKey('2026-11-09T23:30:00Z')).toThrow(RangeError);
  });

  it.for(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'refuses the prototype key %s as a zone',
    (tz) => {
      expect(() => dayKey('2026-11-09T23:30:00Z', tz)).toThrow(RangeError);
    },
  );

  it.for([
    ['2026-02-30T00:00:00Z', 'an impossible date'],
    ['2027-02-29T12:00:00Z', 'February 29 of a common year'],
    ['2026-11-09T24:00:00Z', 'hour 24'],
    ['2026-11-09T23:60:00Z', 'minute 60'],
    ['2026-11-09T23:59:60Z', 'second 60'],
    ['2026-11-09T12:00:00+03:60', 'offset minute 60'],
    ['2026-11-09T12:00:00+24:00', 'offset hour 24'],
    ['2026-11-09T12:00:00.Z', 'an empty fraction'],
  ])('refuses %s (%s)', ([instant]) => {
    expect(() => dayKey(instant as string, 'Asia/Riyadh')).toThrow(RangeError);
  });

  it('truncates a long fraction to milliseconds instead of rounding it', () => {
    // 20:59:59.9995 rounded to milliseconds would be 21:00:00.000Z, the next Riyadh day.
    expect(dayKey('2026-11-09T20:59:59.999999Z', 'Asia/Riyadh')).toBe('2026-11-09');
    expect(dayKey('2026-11-09T20:59:59.999999999Z', 'Asia/Riyadh')).toBe('2026-11-09');
    expect(dayKey('2026-11-09T20:59:59.9995Z', 'Asia/Riyadh')).toBe('2026-11-09');
    expect(dayKey('2026-11-09T21:00:00.000000Z', 'Asia/Riyadh')).toBe('2026-11-10');
    expect(dayKey('2026-11-09T21:00:00.5Z', 'Asia/Riyadh')).toBe('2026-11-10');
  });

  it('follows the instant, not the offset it was written with', () => {
    expect(dayKey('2026-11-10T02:29:59+05:30', 'Asia/Riyadh')).toBe('2026-11-09'); // 20:59:59Z on the 9th
    expect(dayKey('2026-11-10T02:30:00+05:30', 'Asia/Riyadh')).toBe('2026-11-10'); // 21:00Z on the 9th
    expect(dayKey('2026-11-09T13:00:00-08:00', 'Asia/Riyadh')).toBe('2026-11-10'); // 21:00Z
    expect(dayKey('1969-12-31T21:00:00Z', 'Asia/Riyadh')).toBe('1970-01-01');
    expect(dayKey('1969-12-31T20:59:59Z', 'Asia/Riyadh')).toBe('1969-12-31');
  });
});

describe('the browser time zone has no effect', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  // Offsets of 2026-01-01 in each zone, as `getTimezoneOffset` reports them (minutes, west positive).
  it.for([
    ['UTC', 0],
    ['America/Los_Angeles', 480],
    ['Pacific/Kiritimati', -840],
    ['Asia/Riyadh', -180],
  ] as const)('TZ=%s', ([tz, offset]) => {
    process.env.TZ = tz;
    // Proves the process zone really changed; otherwise the assertions below would prove nothing.
    expect(new Date(2026, 0, 1).getTimezoneOffset(), `process offset under TZ=${tz}`).toBe(offset);
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
    ['every n days with n = 1 (the server and the database take n >= 2)', { scheduleKind: 'every_n_days', everyN: 1, anchorDay: '2026-11-09' }],
    ['every n days without an anchor', { scheduleKind: 'every_n_days', everyN: 2, anchorDay: null }],
    ['end before start', { endDay: '2026-11-08' }],
    ['bad start day', { startDay: '2026-02-30' }],
    ['fractional weekday mask', { scheduleKind: 'weekdays', weekdayMask: 1.5 }],
    ['fractional n', { scheduleKind: 'every_n_days', everyN: 2.5, anchorDay: '2026-11-09' }],
    ['bad anchor day on a schedule that does not use it', { anchorDay: '2026-02-30' }],
    ['bad end day', { endDay: '2026-11-31' }],
    ['unknown polarity', { polarity: 'quit' as HabitSpec['polarity'] }],
    ['abstain count habit', { polarity: 'abstain', kind: 'count', unit: 'session' }],
    ['abstain duration habit', { polarity: 'abstain', kind: 'duration', unit: 'min' }],
    ['abstain weekly habit', { polarity: 'abstain', period: 'week' }],
    ['abstain monthly habit', { polarity: 'abstain', period: 'month' }],
    ['abstain target 2', { polarity: 'abstain', targetPerPeriod: 2 }],
    ['abstain target 0.5', { polarity: 'abstain', targetPerPeriod: 0.5 }],
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

  it.for([
    [Number.NaN, 0],
    [0, Number.NaN],
    [Number.POSITIVE_INFINITY, 0],
    [0, Number.NEGATIVE_INFINITY],
    [Number.MAX_VALUE, -Number.MAX_VALUE], // finite inputs whose difference overflows
  ])('goalPrefill refuses goal %s and current %s, as the reference raises', ([goal, current]) => {
    expect(() => goalPrefill(goal as number, current as number, '2026-11-09', '2026-11-30', 'week', 'sun')).toThrow(
      RangeError,
    );
  });

  it('refuses an unknown log status', () => {
    // With an end day: for an open habit challengeProgress returns null before reading the logs,
    // as the reference does.
    const challenge = { ...daily, endDay: '2026-12-08' };
    const logs = [{ day: '2026-11-10', value: 1, status: 'partial' as HabitLog['status'] }];
    for (const rule of habitRules) expect(() => rule(challenge, logs, 'sun')).toThrow(RangeError);
  });

  it('refuses an invalid today in every rule, for open habits and challenges alike', () => {
    const rules = [periodProgress, strength, streak, challengeProgress, adherence];
    for (const spec of [daily, { ...daily, endDay: '2026-12-08' }]) {
      for (const rule of rules) {
        for (const today of ['2026-02-30', '2026-11-9', '']) {
          expect(() => rule(spec, [], today, 'sun'), `${rule.name} ${today}`).toThrow(RangeError);
        }
      }
    }
  });

  it('refuses an invalid log day', () => {
    const logs: HabitLog[] = [{ day: '2026-11-31', value: 1, status: 'done' }];
    for (const rule of habitRules) expect(() => rule({ ...daily, endDay: '2026-12-08' }, logs, 'sun')).toThrow(RangeError);
  });

  it('challengeProgress needs the week start: there is no default', () => {
    const weekly = { ...daily, period: 'week' as const, targetPerPeriod: 3, endDay: '2026-12-08' };
    // @ts-expect-error weekStart is required
    expect(() => challengeProgress(weekly, [], '2026-11-20')).toThrow(RangeError);
  });

  it('sums ten logs of 0.1 to exactly 1, as Python 3.12+ sum() does', () => {
    // Python 3.13: PeriodProgress(done=1.0, completion=1.0, need_per_day=0.0, ...). Naive
    // addition gives 0.9999999999999999, which would show 99% and a positive need per day.
    const monthly: HabitSpec = { ...daily, kind: 'count', unit: 'session', period: 'month', startDay: '2026-11-01' };
    const logs: HabitLog[] = Array.from({ length: 10 }, (_, i) => ({
      day: `2026-11-${String(i + 1).padStart(2, '0')}`,
      value: 0.1,
      status: 'done',
    }));
    const progress = periodProgress(monthly, logs, '2026-11-10', 'sun');
    expect(progress.done).toBe(1);
    expect(progress.completion).toBe(1);
    expect(progress.needPerDay).toBe(0);
    expect(progress.reached).toBe(true);
    expect(progress.expected).toBe(1 / 3);
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

describe('abstain habits (rulesVersion 2, design 9.6)', () => {
  const abstain: HabitSpec = { ...daily, startDay: '2026-11-01', polarity: 'abstain' };
  const twin: HabitSpec = { ...daily, startDay: '2026-11-01' };
  const addDays = (day: string, n: number): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const slip = (day: string): HabitLog => ({ day, value: 1, status: 'done' });

  /** The build twin: `done` on every kept day up to `today`, `skip`/`vacation` as they are. */
  function keptAsBuild(spec: HabitSpec, logs: HabitLog[], today: string): HabitLog[] {
    const last = spec.endDay !== null && spec.endDay < today ? spec.endDay : today;
    const marked = new Set(logs.filter((l) => l.status !== 'missed').map((l) => l.day));
    const kept: HabitLog[] = [];
    for (let day = spec.startDay; day <= last; day = addDays(day, 1)) {
      if (!marked.has(day)) kept.push({ day, value: 1, status: 'done' });
    }
    return [...kept, ...logs.filter((l) => l.status === 'skip' || l.status === 'vacation')];
  }

  it('an omitted polarity is build', () => {
    const logs = [slip('2026-11-09'), slip('2026-11-10')];
    expect(strength({ ...daily, polarity: 'build' }, logs, '2026-11-11', 'sun')).toBe(strength(daily, logs, '2026-11-11', 'sun'));
  });

  it('today is kept until a slip is logged', () => {
    expect(periodProgress(abstain, [], '2026-11-10', 'sun')).toEqual({
      done: 1, target: 1, completion: 1, reached: true, expected: 1, onTrack: true, needPerDay: 0,
    });
    expect(periodProgress(abstain, [slip('2026-11-10')], '2026-11-10', 'sun')).toEqual({
      done: 0, target: 1, completion: 0, reached: false, expected: 1, onTrack: false, needPerDay: 1,
    });
  });

  const slipSets: [string, HabitLog[]][] = [
    ['first day', [slip('2026-11-01')]],
    ['last day', [slip('2026-11-30')]],
    ['three slips', [slip('2026-11-03'), slip('2026-11-15'), slip('2026-11-28')]],
    [
      'slips and neutral days',
      [slip('2026-11-07'), { day: '2026-11-12', value: null, status: 'skip' }, { day: '2026-11-25', value: null, status: 'vacation' }],
    ],
  ];
  const weekStarts: WeekStart[] = ['sat', 'sun', 'mon'];

  it.for(slipSets)('at T equals the build twin on kept days at T + 1: %s', ([, logs]) => {
    for (const endDay of ['2026-11-30', null]) {
      const spec = { ...abstain, endDay };
      const build = { ...twin, endDay };
      for (let offset = -2; offset < 34; offset += 1) {
        const today = addDays('2026-11-01', offset);
        const tomorrow = addDays(today, 1);
        const twinLogs = keptAsBuild(spec, logs, today);
        for (const ws of weekStarts) {
          const at = `${today} ${ws} ${String(endDay)}`;
          expect(strength(spec, logs, today, ws), at).toBe(strength(build, twinLogs, tomorrow, ws));
          expect(streak(spec, logs, today, ws), at).toBe(streak(build, twinLogs, tomorrow, ws));
          expect(adherence(spec, logs, today, ws), at).toBe(adherence(build, twinLogs, tomorrow, ws));
          expect(challengeProgress(spec, logs, today, ws), at).toEqual(challengeProgress(build, twinLogs, tomorrow, ws));
        }
      }
    }
  });
});
