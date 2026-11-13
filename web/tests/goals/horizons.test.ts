import { describe, expect, it } from 'vitest';

import { dueReport, relativeDays } from '../../src/goals/due';
import { horizonLines } from '../../src/goals/horizons';
import { EMPTY_GOALS, goals, milestone, TODAY } from '../helpers/goals-fixtures';

const lines = (over: Parameters<typeof horizonLines>[0]) => Object.fromEntries(horizonLines(over).map((l) => [l.key, l.text]));

describe('horizonLines (design 4.1)', () => {
  const story = lines({ goals: goals(), today: TODAY, openPriorities: 2, habitsLeft: 3 });

  it('says the day line from the open priorities and the habits left', () => {
    expect(story.day).toBe('أولويتان مفتوحتان، و3 عادات باقية');
  });

  it('says the week line with its count and the nearest milestone', () => {
    expect(story.week).toBe('محطتان مستحقتان، أقربها فحص الدم السنوي');
  });

  it('says the month line with the count alone', () => {
    expect(story.month).toBe('4 محطات مستحقة');
  });

  it('says the cycle line: day 11 of 57 and the theme', () => {
    expect(story.cycle).toBe('الدورة 1: اليوم 11 من 57 · التأسيس');
  });

  it('says the plan line: 3 of 122 milestones and the days to the last day, written through fmt, the day count without a grouping comma', () => {
    expect(story.plan).toBe('3 من 122 محطة · 1877 يوماً حتى الأربعاء، 31 ديسمبر 2031');
  });

  it('keeps the order: day, week, month, cycle, plan', () => {
    expect(horizonLines({ goals: goals(), today: TODAY, openPriorities: 2, habitsLeft: 3 }).map((l) => l.key)).toEqual([
      'day',
      'week',
      'month',
      'cycle',
      'plan',
    ]);
  });

  it('a line with nothing in it says «لا شيء مستحق»', () => {
    const empty = lines({ goals: EMPTY_GOALS, today: TODAY, openPriorities: 0, habitsLeft: 0 });
    expect(empty).toEqual({
      day: 'لا شيء مستحق',
      week: 'لا شيء مستحق',
      month: 'لا شيء مستحق',
      cycle: 'لا شيء مستحق',
      plan: 'لا شيء مستحق',
    });
  });

  it('leaves the day line unknown (null) until the priorities and habits are loaded', () => {
    expect(lines({ goals: goals(), today: TODAY, openPriorities: null, habitsLeft: 3 }).day).toBeNull();
  });

  it('counts one, two and many in the week line', () => {
    const one = goals({ milestones: [milestone('a', 'محطة وحيدة', { due_date: '2026-11-11' })] });
    expect(lines({ goals: one, today: TODAY, openPriorities: 0, habitsLeft: 0 }).week).toBe('محطة واحدة مستحقة، أقربها محطة وحيدة');
  });

  it('agrees the count with its noun: 11 and 103 as the language does', () => {
    const many = (n: number) =>
      goals({ milestones: Array.from({ length: n }, (_, i) => milestone(`m${i}`, 'م', { due_date: '2026-11-20' })) });
    expect(lines({ goals: many(11), today: TODAY, openPriorities: 0, habitsLeft: 0 }).month).toBe('11 محطة مستحقة');
    expect(lines({ goals: many(103), today: TODAY, openPriorities: 0, habitsLeft: 0 }).month).toBe('103 محطات مستحقة');
    expect(lines({ goals: many(1), today: TODAY, openPriorities: 0, habitsLeft: 0 }).month).toBe('محطة واحدة مستحقة');
    const day = (p: number, h: number) => lines({ goals: goals(), today: TODAY, openPriorities: p, habitsLeft: h }).day;
    expect(day(11, 11)).toBe('11 أولوية مفتوحة، و11 عادة باقية');
    expect(day(1, 1)).toBe('أولوية واحدة مفتوحة، وعادة واحدة باقية');
    expect(day(2, 2)).toBe('أولويتان مفتوحتان، وعادتان باقيتان');
    expect(day(0, 103)).toBe('لا أولويات مفتوحة، و103 عادات باقية');
  });

  it('does not count a milestone that is done or already late', () => {
    const g = goals({
      milestones: [
        milestone('a', 'منجزة', { due_date: '2026-11-11', done: true }),
        milestone('b', 'فائتة', { due_date: '2026-11-09', overdue_days: 1 }),
      ],
    });
    expect(lines({ goals: g, today: TODAY, openPriorities: 0, habitsLeft: 0 }).week).toBe('لا شيء مستحق');
  });

  it('says the last day of the cycle and a plan not yet started', () => {
    const g = goals();
    expect(lines({ goals: g, today: '2026-12-26', openPriorities: 0, habitsLeft: 0 }).cycle).toBe('الدورة 1: اليوم 57 من 57 · التأسيس');
    expect(lines({ goals: g, today: '2026-10-01', openPriorities: 0, habitsLeft: 0 }).cycle).toMatch(/^تبدأ الدورة 1 في /);
  });
});

describe('due report', () => {
  it('puts the late milestones first, most late first, then the coming ones by date', () => {
    const report = dueReport(goals().milestones, TODAY);
    expect(report.overdue.map((i) => [i.milestone.page_id, i.offset])).toEqual([['m-late', -2]]);
    expect(report.upcoming.slice(0, 4).map((i) => [i.milestone.page_id, i.offset])).toEqual([
      ['m-blood', 2],
      ['m-cert', 3],
      ['m-five', 5],
      ['m-month', 18],
    ]);
  });

  it('leaves out the done milestones and the ones without a date', () => {
    const report = dueReport(
      [milestone('a', 'a', { done: true, due_date: '2026-11-11' }), milestone('b', 'b', { due_date: null })],
      TODAY,
    );
    expect(report.overdue).toEqual([]);
    expect(report.upcoming).toEqual([]);
  });

  it('writes the distance the way the brief says', () => {
    expect(relativeDays(-2)).toBe('متأخرة يومين');
    expect(relativeDays(-1)).toBe('متأخرة يوماً واحداً');
    expect(relativeDays(-3)).toBe('متأخرة 3 أيام');
    expect(relativeDays(-12)).toBe('متأخرة 12 يوماً');
    expect(relativeDays(0)).toBe('اليوم');
    expect(relativeDays(1)).toBe('غداً');
    expect(relativeDays(2)).toBe('بعد يومين');
    expect(relativeDays(5)).toBe('بعد 5 أيام');
    expect(relativeDays(11)).toBe('بعد 11 يوماً');
  });
});
