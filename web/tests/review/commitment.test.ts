import { describe, expect, it } from 'vitest';

import { monthCommitment } from '../../src/review/commitment';
import { habit, type HabitLogOut } from '../helpers/today-fixtures';

const log = (habit_code: string, day: string, status = 'done'): HabitLogOut => ({ habit_code, day, value: null, status });
const NOV = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `2026-11-${String(from + i).padStart(2, '0')}`);

const base = { today: '2026-11-14', weekStart: 'sun' as const };

describe('monthCommitment: the daily habit days kept in a month, up to today', () => {
  const walk = habit('walk', 'المشي');

  it('counts the days from the first of the month to today: 7 kept of 14', () => {
    const logs = NOV(8, 14).map((d) => log('walk', d));
    expect(monthCommitment({ ...base, habits: [walk], logs, month: '2026-11' })).toEqual({ reached: 7, total: 14 });
  });

  it('a skipped day is in neither number', () => {
    const logs = [...NOV(8, 14).map((d) => log('walk', d)), log('walk', '2026-11-03', 'skip'), log('walk', '2026-11-04', 'vacation')];
    expect(monthCommitment({ ...base, habits: [walk], logs, month: '2026-11' })).toEqual({ reached: 7, total: 12 });
  });

  it('an abstain habit keeps every day without a slip', () => {
    const quiet = habit('quiet', 'امتناع', { polarity: 'abstain' });
    expect(monthCommitment({ ...base, habits: [quiet], logs: [log('quiet', '2026-11-10')], month: '2026-11' })).toEqual({ reached: 13, total: 14 });
    expect(monthCommitment({ ...base, habits: [walk, quiet], logs: NOV(1, 14).map((d) => log('walk', d)), month: '2026-11' })).toEqual({ reached: 28, total: 28 });
  });

  it('a past month is whole, from the start day of the habit', () => {
    const old = habit('old', 'قديمة', { start_day: '2026-09-10' });
    expect(monthCommitment({ ...base, habits: [old], logs: [], month: '2026-10' })).toEqual({ reached: 0, total: 31 });
    expect(monthCommitment({ ...base, habits: [old], logs: [], month: '2026-09' })).toEqual({ reached: 0, total: 21 });
  });

  it('a habit that ended counts until its last day', () => {
    const ended = habit('ended', 'انتهت', { start_day: '2026-10-01', end_day: '2026-11-05' });
    expect(monthCommitment({ ...base, habits: [ended], logs: [], month: '2026-11' })).toEqual({ reached: 0, total: 5 });
  });

  it('weekly and monthly habits, and archived ones, are not days', () => {
    const weekly = habit('wk', 'أسبوعية', { period: 'week', target_per_period: 3 });
    const archived = habit('gone', 'مؤرشفة', { active: false });
    expect(monthCommitment({ ...base, habits: [weekly, archived], logs: [log('wk', '2026-11-09')], month: '2026-11' })).toBeNull();
  });

  it('is null for a month with no due day: before the habit, after today, or without habits', () => {
    expect(monthCommitment({ ...base, habits: [walk], logs: [], month: '2026-08' })).toBeNull();
    expect(monthCommitment({ ...base, habits: [walk], logs: [], month: '2026-12' })).toBeNull();
    expect(monthCommitment({ ...base, habits: [], logs: [], month: '2026-11' })).toBeNull();
  });
});

describe('monthCommitment: archiving a habit does not change a month that is over (Task 21 N-1)', () => {
  const octDays = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, '0')}`);

  it('an archived habit still counts: a month before its last logged day is the same before and after', () => {
    const logs = [...octDays(1, 20), '2026-11-03', '2026-11-04'].map((d) => log('walk', d));
    const live = habit('walk', 'المشي', { start_day: '2026-10-01' });
    const archived = { ...live, active: false };
    const before = monthCommitment({ ...base, habits: [live], logs, month: '2026-10' });
    expect(before).toEqual({ reached: 20, total: 31 });
    expect(monthCommitment({ ...base, habits: [archived], logs, month: '2026-10' })).toEqual(before);
  });

  it('but only up to the last day it was logged: the days after are not owed', () => {
    const logs = octDays(1, 20).map((d) => log('walk', d));
    const archived = habit('walk', 'المشي', { start_day: '2026-10-01', active: false });
    expect(monthCommitment({ ...base, habits: [archived], logs, month: '2026-10' })).toEqual({ reached: 20, total: 20 });
    expect(monthCommitment({ ...base, habits: [archived], logs, month: '2026-11' })).toBeNull();
  });

  it('an archived habit with no log at all stays out (nothing says it was ever kept)', () => {
    const archived = habit('walk', 'المشي', { start_day: '2026-10-01', active: false });
    expect(monthCommitment({ ...base, habits: [archived], logs: [], month: '2026-10' })).toBeNull();
  });

  it('an archived habit is counted with the others of its month', () => {
    const walk = habit('walk', 'المشي', { start_day: '2026-10-01', active: false });
    const read = habit('read', 'القراءة', { start_day: '2026-10-01' });
    const logs = [...octDays(1, 10).map((d) => log('walk', d)), ...octDays(1, 31).map((d) => log('read', d))];
    expect(monthCommitment({ ...base, habits: [walk, read], logs, month: '2026-10' })).toEqual({ reached: 41, total: 41 });
  });
});
