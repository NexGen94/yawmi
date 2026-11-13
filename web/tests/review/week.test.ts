import { describe, expect, it } from 'vitest';

import { weekBounds, weekSummary } from '../../src/review/week';
import { goals, milestone } from '../helpers/goals-fixtures';
import { habit, type HabitLogOut, type JournalEntryOut } from '../helpers/today-fixtures';

// The week of Sunday 2026-11-08 to Saturday 2026-11-14 (the plan's weeks start on Sunday).
const SAT = '2026-11-14';
const WEEK = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];

const log = (habit_code: string, day: string, value: number | null = null, status = 'done'): HabitLogOut => ({
  habit_code,
  day,
  value,
  status,
});

const entry = (day: string, part: 'morning' | 'evening'): JournalEntryOut => ({
  day,
  part,
  answers: {},
  logged_at: `${day}T10:00:00Z`,
});

const input = (over: Partial<Parameters<typeof weekSummary>[0]> = {}): Parameters<typeof weekSummary>[0] => ({
  habits: [],
  logs: [],
  journal: [],
  today: SAT,
  weekStart: 'sun',
  ...over,
});

describe('weekBounds', () => {
  it('is the Sunday to Saturday week that holds the day', () => {
    expect(weekBounds('2026-11-10', 'sun')).toEqual({ start: '2026-11-08', end: '2026-11-14' });
    expect(weekBounds('2026-11-08', 'sun')).toEqual({ start: '2026-11-08', end: '2026-11-14' });
    expect(weekBounds('2026-11-14', 'sun')).toEqual({ start: '2026-11-08', end: '2026-11-14' });
  });
});

describe('weekSummary: the journals', () => {
  it('counts the days of the week with a morning journal and with an evening journal', () => {
    const journal = [
      ...WEEK.slice(0, 4).map((d) => entry(d, 'morning')),
      ...WEEK.slice(1, 6).map((d) => entry(d, 'evening')),
    ];
    expect(weekSummary(input({ journal })).journal).toEqual({ morning: 4, evening: 5 });
  });

  it('leaves out the days outside the week and the days after today, and counts a day once', () => {
    const journal = [
      entry('2026-11-07', 'morning'),
      entry('2026-11-08', 'morning'),
      entry('2026-11-08', 'morning'),
      entry('2026-11-15', 'morning'),
      entry('2026-11-12', 'evening'),
    ];
    expect(weekSummary(input({ journal, today: '2026-11-12' })).journal).toEqual({ morning: 1, evening: 1 });
    expect(weekSummary(input({ journal, today: '2026-11-10' })).journal).toEqual({ morning: 1, evening: 0 });
  });

  it('is zero without entries', () => {
    expect(weekSummary(input()).journal).toEqual({ morning: 0, evening: 0 });
  });
});

describe('weekSummary: by criterion', () => {
  const english = habit('english_minutes', 'دقائق الإنجليزية', {
    ac_ref: 'AC7.4',
    kind: 'duration',
    unit: 'min',
    period: 'week',
    target_per_period: 285,
  });

  it('reads the week of a habit with an acceptance criterion: 85 of 285', () => {
    const logs = [
      log('english_minutes', '2026-11-09', 40),
      log('english_minutes', '2026-11-10', 45),
      log('english_minutes', '2026-11-01', 60),
    ];
    expect(weekSummary(input({ habits: [english], logs })).byCriterion).toEqual([{ ac: 'AC7.4', done: 85, target: 285 }]);
  });

  it('draws only the criteria some habit carries, in the order AC3.4, AC2.7, AC7.4', () => {
    const journal = habit('journal_morning', 'يومية الصباح', { ac_ref: 'AC3.4', period: 'week', target_per_period: 5 });
    const meditation = habit('meditation', 'جلسة تأمّل', { ac_ref: 'AC2.7', period: 'week', target_per_period: 5 });
    const logs = [log('meditation', '2026-11-09'), log('meditation', '2026-11-10'), log('journal_morning', '2026-11-11')];
    const rows = weekSummary(input({ habits: [english, meditation, journal], logs })).byCriterion;
    expect(rows.map((r) => r.ac)).toEqual(['AC3.4', 'AC2.7', 'AC7.4']);
    expect(rows[0]).toEqual({ ac: 'AC3.4', done: 1, target: 5 });
    expect(rows[1]).toEqual({ ac: 'AC2.7', done: 2, target: 5 });
    expect(weekSummary(input({ habits: [meditation] })).byCriterion.map((r) => r.ac)).toEqual(['AC2.7']);
    expect(weekSummary(input()).byCriterion).toEqual([]);
  });

  it('a habit with another reference, or with none, is not a row', () => {
    const other = habit('family', 'نصف يوم الأسرة', { ac_ref: 'AC11.1', period: 'week' });
    expect(weekSummary(input({ habits: [other, habit('plain', 'بلا معيار')] })).byCriterion).toEqual([]);
  });

  it('two habits of one criterion add up when they count the same thing; the larger target leads when they do not', () => {
    const a = habit('journal_morning', 'يومية الصباح', { ac_ref: 'AC3.4', period: 'week', target_per_period: 5 });
    const b = habit('journal_evening', 'يومية المساء', { ac_ref: 'AC3.4', period: 'week', target_per_period: 5 });
    const logs = [log('journal_morning', '2026-11-09'), log('journal_evening', '2026-11-09'), log('journal_evening', '2026-11-10')];
    expect(weekSummary(input({ habits: [a, b], logs })).byCriterion).toEqual([{ ac: 'AC3.4', done: 3, target: 10 }]);

    const speaking = habit('english_speaking', 'جلسة محادثة', {
      ac_ref: 'AC7.4',
      kind: 'count',
      unit: 'session',
      period: 'week',
      target_per_period: 2,
    });
    const rows = weekSummary(
      input({ habits: [speaking, english], logs: [log('english_minutes', '2026-11-09', 85), log('english_speaking', '2026-11-09', 1)] }),
    ).byCriterion;
    expect(rows).toEqual([{ ac: 'AC7.4', done: 85, target: 285 }]);
  });

  it('an archived habit, and one that has not started, are not rows', () => {
    const archived = { ...english, active: false };
    const later = { ...english, start_day: '2026-12-01' };
    expect(weekSummary(input({ habits: [archived] })).byCriterion).toEqual([]);
    expect(weekSummary(input({ habits: [later] })).byCriterion).toEqual([]);
  });
});

describe('weekSummary: adherence', () => {
  const quiet = habit('no_late_screen', 'بلا شاشة متأخرة', { polarity: 'abstain' });

  it('an abstain habit with one slip in the week keeps six days of seven', () => {
    expect(weekSummary(input({ habits: [quiet], logs: [log('no_late_screen', '2026-11-10')] })).adherence).toEqual({
      reached: 6,
      total: 7,
    });
  });

  it('counts only the days up to today as reached, against the days of the whole week', () => {
    expect(weekSummary(input({ habits: [quiet], today: '2026-11-10' })).adherence).toEqual({ reached: 3, total: 7 });
    expect(
      weekSummary(input({ habits: [quiet], logs: [log('no_late_screen', '2026-11-09')], today: '2026-11-10' })).adherence,
    ).toEqual({ reached: 2, total: 7 });
  });

  it('a daily build habit adds the days it met its target, and a skipped day is in neither number', () => {
    const walk = habit('walk', 'المشي');
    const logs = [log('walk', '2026-11-08'), log('walk', '2026-11-09'), log('walk', '2026-11-11'), log('walk', '2026-11-10', null, 'skip')];
    expect(weekSummary(input({ habits: [walk], logs, today: SAT })).adherence).toEqual({ reached: 3, total: 6 });
    expect(weekSummary(input({ habits: [walk, quiet], logs, today: SAT })).adherence).toEqual({ reached: 3 + 7, total: 6 + 7 });
  });

  it('weekly and monthly habits are not days: they are not in the number', () => {
    const weekly = habit('wk', 'أسبوعية', { period: 'week', target_per_period: 3 });
    expect(weekSummary(input({ habits: [weekly], logs: [log('wk', '2026-11-09')] })).adherence).toEqual({ reached: 0, total: 0 });
  });

  it('a habit that starts in the middle of the week counts from its start day, and one that ended before it not at all', () => {
    const starting = habit('late_start', 'بدأت الأربعاء', { start_day: '2026-11-11' });
    expect(
      weekSummary(input({ habits: [starting], logs: [log('late_start', '2026-11-11'), log('late_start', '2026-11-12')] })).adherence,
    ).toEqual({ reached: 2, total: 4 });
    const ended = habit('ended', 'انتهت', { end_day: '2026-11-05' });
    expect(weekSummary(input({ habits: [ended] })).adherence).toEqual({ reached: 0, total: 0 });
  });

  it('is zero of zero without daily habits', () => {
    expect(weekSummary(input()).adherence).toEqual({ reached: 0, total: 0 });
  });
});

describe('weekSummary: done, blocked, next', () => {
  it('done: the habits that met their target this week', () => {
    const weekly = habit('wk', 'قراءة أسبوعية', { period: 'week', target_per_period: 3 });
    const short = habit('short', 'تمرين أسبوعي', { period: 'week', target_per_period: 3 });
    const logs = [log('wk', '2026-11-08'), log('wk', '2026-11-10'), log('wk', '2026-11-12'), log('short', '2026-11-09')];
    expect(weekSummary(input({ habits: [weekly, short], logs })).done).toEqual(['قراءة أسبوعية']);
  });

  it('done: a daily habit kept every scheduled day up to today (a day still open is not asked)', () => {
    const walk = habit('walk', 'المشي');
    const logs = WEEK.slice(0, 3).map((d) => log('walk', d));
    expect(weekSummary(input({ habits: [walk], logs, today: '2026-11-11' })).done).toEqual(['المشي']);
    expect(weekSummary(input({ habits: [walk], logs: logs.slice(0, 2), today: '2026-11-11' })).done).toEqual([]);
  });

  it('done: an abstain habit is never in the list, and an archived habit neither', () => {
    const quiet = habit('q', 'امتناع', { polarity: 'abstain' });
    const archived = habit('old', 'قديمة', { period: 'week', target_per_period: 1, active: false });
    expect(weekSummary(input({ habits: [quiet, archived], logs: [log('old', '2026-11-09')] })).done).toEqual([]);
  });

  it('blocked: the habits whose state is late, and the open milestones past their day', () => {
    const missed = habit('missed', 'عادة فاتت أمس');
    const fine = habit('fine', 'عادة سليمة');
    const g = goals({
      milestones: [
        milestone('m1', 'محطة متأخرة', { due_date: '2026-11-05' }),
        milestone('m2', 'محطة منجزة', { due_date: '2026-11-05', done: true }),
        milestone('m3', 'محطة قادمة', { due_date: '2026-11-20' }),
        milestone('m4', 'محطة بلا موعد', { due_date: null }),
      ],
    });
    const out = weekSummary(input({ habits: [missed, fine], logs: [log('fine', '2026-11-13')], goals: g }));
    expect(out.blocked).toEqual(['عادة فاتت أمس', 'محطة متأخرة']);
  });

  it('next: the open milestones due within 14 days, nearest first', () => {
    const g = goals({
      milestones: [
        milestone('a', 'بعد أسبوعين', { due_date: '2026-11-28' }),
        milestone('b', 'أقرب', { due_date: '2026-11-14' }),
        milestone('c', 'أبعد من أسبوعين', { due_date: '2026-11-29' }),
        milestone('d', 'منجزة', { due_date: '2026-11-16', done: true }),
        milestone('e', 'فاتت', { due_date: '2026-11-13' }),
        milestone('f', 'وسط', { due_date: '2026-11-20' }),
      ],
    });
    expect(weekSummary(input({ goals: g })).next).toEqual(['أقرب', 'وسط', 'بعد أسبوعين']);
  });

  it('without the goals the lists hold the habits only, and are empty with nothing', () => {
    const out = weekSummary(input());
    expect(out.done).toEqual([]);
    expect(out.blocked).toEqual([]);
    expect(out.next).toEqual([]);
  });
});
