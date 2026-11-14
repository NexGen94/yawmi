import { describe, expect, it } from 'vitest';

import type { HabitLogOut } from '../../src/data/pending';
import { dayStates, GRID_DAYS, gridStart, periodMarks } from '../../src/pages/habits/dayStates';
import { habit } from '../helpers/today-fixtures';

const TODAY = '2026-11-10'; // a Tuesday
const FIRST = '2026-10-31'; // day 1 of the cycle (day 11 is today)

const done = (code: string, day: string, value: number | null = null): HabitLogOut => ({ habit_code: code, day, status: 'done', value });
const log = (code: string, day: string, status: HabitLogOut['status']): HabitLogOut => ({ habit_code: code, day, status, value: null });
const stateOf = (days: ReturnType<typeof dayStates>, day: string) => days.find((d) => d.day === day)?.state;
const count = (days: ReturnType<typeof dayStates>, state: string) => days.filter((d) => d.state === state).length;

describe('gridStart: the 56 days of the cycle', () => {
  it('starts on day 1 of the cycle: today minus (day in the cycle - 1)', () => {
    expect(gridStart(TODAY, 11)).toEqual({ first: '2026-10-31', cycle: true, days: 56 });
    expect(gridStart(TODAY, 1)).toEqual({ first: TODAY, cycle: true, days: 56 });
    expect(gridStart(TODAY, 56)).toEqual({ first: '2026-09-16', cycle: true, days: 56 });
  });

  it('falls back to the last 56 days when the plan does not say, or says something impossible', () => {
    for (const day of [null, undefined, 0, 57, 1.5]) {
      expect(gridStart(TODAY, day)).toEqual({ first: '2026-09-16', cycle: false, days: 56 });
    }
  });
});

describe('the grid follows the length of the cycle (Task 24, design review #8)', () => {
  it('a 57-day cycle (the first, 31 October to 26 December) is 57 cells, the same length the home and goals pages say', () => {
    const grid = gridStart(TODAY, 11, 57);
    expect(grid).toEqual({ first: '2026-10-31', cycle: true, days: 57 });
    const walk = habit('walk', 'المشي', { start_day: '2026-11-01' });
    const days = dayStates(walk, [], grid.first, TODAY, grid.days);
    expect(days).toHaveLength(57);
    expect(days[56]?.day).toBe('2026-12-26');
  });

  it('an 84-day cycle is 84 cells, and day 57 of it is a day of the cycle', () => {
    const grid = gridStart(TODAY, 57, 84);
    expect(grid.cycle).toBe(true);
    expect(grid.days).toBe(84);
  });

  it('in the review week after a cycle (day 58 to 64 of a 57-day cycle) the grid is the cycle that just ended, whole (Task 25, I-1)', () => {
    expect(gridStart('2026-12-27', 58, 57)).toEqual({ first: '2026-10-31', cycle: true, days: 57 });
    expect(gridStart('2026-12-28', 59, 57)).toEqual({ first: '2026-10-31', cycle: true, days: 57 });
    expect(gridStart('2027-01-02', 64, 57)).toEqual({ first: '2026-10-31', cycle: true, days: 57 });
    // past the review week the plan says something that is not a day of the cycle: the last 56 days
    expect(gridStart('2027-01-03', 65, 57).cycle).toBe(false);
  });

  it('without a length (no mirror yet) it is the 56 days it always was', () => {
    expect(gridStart(TODAY, 11)).toEqual({ first: '2026-10-31', cycle: true, days: 56 });
    expect(gridStart(TODAY, null)).toEqual({ first: '2026-09-16', cycle: false, days: 56 });
  });
});

describe('dayStates: a daily habit', () => {
  const walk = habit('walk', 'المشي', { start_day: '2026-11-01' });

  it('draws exactly 56 days from the first, today inside, the rest empty future cells', () => {
    const days = dayStates(walk, [], FIRST, TODAY);
    expect(days).toHaveLength(GRID_DAYS);
    expect(days[0]?.day).toBe(FIRST);
    expect(days[55]?.day).toBe('2026-12-25');
    expect(count(days, 'future')).toBe(45);
    expect(stateOf(days, '2026-11-11')).toBe('future');
  });

  it('a day before the start is not scheduled', () => {
    expect(stateOf(dayStates(walk, [], FIRST, TODAY), '2026-10-31')).toBe('off');
  });

  it('✕ is only for a scheduled past day of a daily habit that has no log', () => {
    const days = dayStates(walk, [done('walk', '2026-11-08'), log('walk', '2026-11-07', 'skip')], FIRST, TODAY);
    expect(stateOf(days, '2026-11-08')).toBe('done');
    expect(stateOf(days, '2026-11-07')).toBe('skipped');
    expect(stateOf(days, '2026-11-05')).toBe('missed');
    expect(count(days, 'missed')).toBe(7); // the 1st to the 6th and the 9th
  });

  it('today with nothing logged is «لا تسجيل» with its own words and a ring, never a miss', () => {
    const today = dayStates(walk, [], FIRST, TODAY).find((d) => d.day === TODAY);
    expect(today).toMatchObject({ state: 'none', current: true });
    expect(today?.note).toBe('اليوم: لم يُسجَّل بعد');
  });

  it('today logged done is done, and still carries the ring', () => {
    const today = dayStates(walk, [done('walk', TODAY)], FIRST, TODAY).find((d) => d.day === TODAY);
    expect(today).toMatchObject({ state: 'done', current: true });
  });

  it('a count or duration day short of its target is not done', () => {
    const english = habit('english', 'الإنجليزية', { kind: 'duration', unit: 'min', target_per_period: 45, start_day: '2026-11-01' });
    const days = dayStates(english, [done('english', '2026-11-08', 20), done('english', '2026-11-09', 45)], FIRST, TODAY);
    expect(stateOf(days, '2026-11-08')).toBe('missed');
    expect(stateOf(days, '2026-11-09')).toBe('done');
  });

  it('a day the habit is not scheduled on is not scheduled, not missed', () => {
    const saturdays = habit('sat', 'السبت', { schedule_kind: 'weekdays', weekday_mask: 64, start_day: '2026-11-01' });
    const days = dayStates(saturdays, [], FIRST, TODAY);
    expect(stateOf(days, '2026-11-03')).toBe('off');
    expect(stateOf(days, '2026-11-07')).toBe('missed'); // the one Saturday since the start
  });
});

describe('dayStates: a weekly or monthly habit is judged on its period, not on its days', () => {
  const weekly = habit('week_walk', 'مشي أسبوعي', { period: 'week', target_per_period: 2, start_day: '2026-11-01' });

  it('a past day with no log is «لا تسجيل», never «لم يُنجز»', () => {
    // the week of the 1st is met (two logs) and the week of the 8th is met (two logs): most days are empty
    const logs = [done('week_walk', '2026-11-01'), done('week_walk', '2026-11-03'), done('week_walk', '2026-11-08'), done('week_walk', '2026-11-09')];
    const days = dayStates(weekly, logs, FIRST, TODAY);
    expect(count(days, 'missed')).toBe(0);
    expect(count(days, 'done')).toBe(4);
    expect(stateOf(days, '2026-11-05')).toBe('none');
    expect(stateOf(days, '2026-11-02')).toBe('none');
    expect(count(days, 'none')).toBe(10 - 4); // the 1st..10th minus the four logged days (today included)
  });

  it('a monthly habit too', () => {
    const monthly = habit('read_month', 'قراءة شهرية', { period: 'month', target_per_period: 3, start_day: '2026-11-01' });
    const days = dayStates(monthly, [done('read_month', '2026-11-04')], FIRST, TODAY);
    expect(count(days, 'missed')).toBe(0);
    expect(stateOf(days, '2026-11-02')).toBe('none');
  });

  it('a skip or vacation day is still skipped', () => {
    const days = dayStates(weekly, [log('week_walk', '2026-11-04', 'vacation')], FIRST, TODAY);
    expect(stateOf(days, '2026-11-04')).toBe('skipped');
  });
});

describe('dayStates: an abstain habit', () => {
  const sugar = habit('no_sugar', 'ترك السكر', { polarity: 'abstain', start_day: '2026-11-01' });

  it('a clean scheduled day is kept (done), today included, and a slip is the miss', () => {
    const days = dayStates(sugar, [done('no_sugar', '2026-11-09')], FIRST, TODAY);
    expect(stateOf(days, '2026-11-09')).toBe('missed');
    expect(stateOf(days, '2026-11-08')).toBe('done');
    expect(stateOf(days, TODAY)).toBe('done');
    expect(count(days, 'done')).toBe(9);
    expect(count(days, 'none')).toBe(0);
  });
});

describe('periodMarks: the outcome of each period of a weekly or monthly habit', () => {
  const weekly = habit('week_walk', 'مشي أسبوعي', { period: 'week', target_per_period: 2, start_day: '2026-11-01' });

  it('has none for a daily habit', () => {
    expect(periodMarks(habit('walk', 'المشي'), [], FIRST, TODAY)).toEqual([]);
  });

  it('marks a met week and the current week that is already met, though most days are empty', () => {
    const logs = [done('week_walk', '2026-11-01'), done('week_walk', '2026-11-03'), done('week_walk', '2026-11-08'), done('week_walk', '2026-11-09')];
    expect(periodMarks(weekly, logs, FIRST, TODAY)).toEqual([
      { start: '2026-11-01', end: '2026-11-07', outcome: 'met' },
      { start: '2026-11-08', end: '2026-11-14', outcome: 'met' },
    ]);
  });

  it('marks a finished week that fell short «notMet» and a current week still open «ongoing»', () => {
    const logs = [done('week_walk', '2026-11-02'), done('week_walk', '2026-11-08')];
    expect(periodMarks(weekly, logs, FIRST, TODAY).map((m) => m.outcome)).toEqual(['notMet', 'ongoing']);
  });

  it('leaves out the periods before the habit started and the ones that have not come', () => {
    const marks = periodMarks({ ...weekly, start_day: '2026-11-08' }, [], FIRST, TODAY);
    expect(marks).toEqual([{ start: '2026-11-08', end: '2026-11-14', outcome: 'ongoing' }]);
  });

  it('reads a month the same way', () => {
    const monthly = habit('read_month', 'قراءة شهرية', { period: 'month', target_per_period: 1, start_day: '2026-10-31' });
    const marks = periodMarks(monthly, [done('read_month', '2026-11-04')], FIRST, TODAY);
    expect(marks.map((m) => m.outcome)).toEqual(['notMet', 'met']);
    expect(marks[1]).toMatchObject({ start: '2026-11-01', end: '2026-11-30' });
  });
});
