// The habit indicator of design 9.3, with the examples of that table.
import { afterEach, describe, expect, it } from 'vitest';

import { fromOrdinal, toOrdinal } from '../../src/domain/days';
import type { IndicatorIO } from '../../src/indicators/types';
import { setDigits } from '../../src/lib/format';
import { habitIndicator } from '../../src/progress/indicator';
import { habit } from '../helpers/today-fixtures';

afterEach(() => setDigits('latn'));

const TUESDAY = '2026-11-10';
const log = (day: string, value: number | null = null, status: 'done' | 'skip' | 'vacation' | 'missed' = 'done') => ({ day, value, status });

const cfg = (over: Partial<IndicatorIO> = {}): IndicatorIO => ({
  subject_kind: 'habit',
  subject_ref: 'h',
  source: 'habit_logs',
  measure: 'completion',
  period: 'week',
  display: 'ring',
  ...over,
});

/** S3: a weekly duration habit of 285 minutes, 60 on Sunday and 25 today. */
const ENGLISH = habit('english', 'الإنجليزية', { kind: 'duration', unit: 'min', period: 'week', target_per_period: 285, start_day: '2026-11-01' });
const ENGLISH_LOGS = [log('2026-11-08', 60), log(TUESDAY, 25)];

describe('habitIndicator', () => {
  it('completion: 85 of 285 is 0.298246 and reads 30%', () => {
    const view = habitIndicator(ENGLISH, ENGLISH_LOGS, undefined, TUESDAY, 'sun');
    expect(view.completion).toBeCloseTo(0.298246, 6);
    expect(view.value).toBeCloseTo(0.298246, 6);
    expect(view.text).toBe('30%');
    expect(view.reason).toBeUndefined();
  });

  it('total: 60 + 25 = 85 minutes this week', () => {
    const view = habitIndicator(ENGLISH, ENGLISH_LOGS, cfg({ measure: 'total', period: 'week' }), TUESDAY, 'sun');
    expect(view.value).toBe(85);
    expect(view.target).toBeNull();
    expect(view.text).toBe('85 دقيقة');
  });

  it('total against a target', () => {
    const view = habitIndicator(ENGLISH, ENGLISH_LOGS, cfg({ measure: 'total', period: 'week', target: 300 }), TUESDAY, 'sun');
    expect(view.value).toBe(85);
    expect(view.target).toBe(300);
    expect(view.completion).toBeCloseTo(85 / 300, 6);
    expect(view.text).toBe('85 من 300 دقيقة');
  });

  it('total counts only the chosen period: the day, the month, the cycle, all', () => {
    const logs = [log('2026-11-01', 10), log('2026-11-04', 20), log('2026-11-08', 60), log(TUESDAY, 25)];
    const total = (period: IndicatorIO['period'], cycleStart?: string) =>
      habitIndicator(ENGLISH, logs, cfg({ measure: 'total', period }), TUESDAY, 'sun', undefined, cycleStart).value;
    expect(total('day')).toBe(25);
    expect(total('week')).toBe(85);
    expect(total('month')).toBe(115);
    expect(total('cycle', '2026-11-04')).toBe(105);
    expect(total('all')).toBe(115);
  });

  it('a yes/no habit totals its days', () => {
    const run = habit('run', 'الجري', { start_day: '2026-11-01' });
    const view = habitIndicator(run, [log('2026-11-08'), log('2026-11-09'), log(TUESDAY)], cfg({ measure: 'total', period: 'week' }), TUESDAY, 'sun');
    expect(view.value).toBe(3);
    expect(view.text).toBe('3 أيام');
  });

  describe('averages', () => {
    const steps = habit('steps', 'الخطوات', { kind: 'count', unit: '', start_day: '2026-10-01' });
    // [8000, 6500, 0, 9000, 7500, 8200, 7000]: Wednesday 11-04 has no log, so it counts 0.
    const week = [
      log('2026-11-04', 8000),
      log('2026-11-05', 6500),
      log('2026-11-07', 9000),
      log('2026-11-08', 7500),
      log('2026-11-09', 8200),
      log(TUESDAY, 7000),
    ];
    const measure = (logs: ReturnType<typeof log>[], today: string, measure: IndicatorIO['measure'] = 'avg_7d') =>
      habitIndicator(steps, logs, cfg({ measure, period: 'day', target: 8000 }), today, 'sun');

    it('6600 against 8000 is 0.825', () => {
      // 11-04 .. 11-10 is seven days: 8000, 6500, (11-06 none: 0), 9000, 7500, 8200, 7000
      const view = measure(week, TUESDAY);
      expect(view.value).toBeCloseTo(6600, 6);
      expect(view.target).toBe(8000);
      expect(view.completion).toBeCloseTo(0.825, 6);
      expect(view.text).toBe('6,600 من 8,000');
    });

    it('a day without a log ends the window the day before', () => {
      // Today (11-11) has no log: the window is 11-05 .. 11-11? no: it ends yesterday, 11-10.
      const view = measure(week, '2026-11-11');
      expect(view.value).toBeCloseTo(6600, 6);
    });

    it('a skipped day leaves the denominator', () => {
      const skipped = week.map((l) => (l.day === '2026-11-07' ? log('2026-11-07', null, 'skip') : l));
      // six counted days: 8000 + 6500 + 0 (11-06) + 7500 + 8200 + 7000 over six
      // (11-04 is still the first day of the window)
      const view = measure(skipped, TUESDAY);
      expect(view.value).toBeCloseTo((8000 + 6500 + 0 + 7500 + 8200 + 7000) / 6, 6);
    });

    it('thirty days use the thirty-day window', () => {
      const view = measure([log(TUESDAY, 3000)], TUESDAY, 'avg_30d');
      expect(view.value).toBeCloseTo(3000 / 30, 6);
    });

    it('days before the habit started are not days of its average', () => {
      const fresh = habit('fresh', 'جديدة', { kind: 'count', unit: '', start_day: '2026-11-09' });
      const view = habitIndicator(fresh, [log('2026-11-09', 10), log(TUESDAY, 20)], cfg({ measure: 'avg_7d', period: 'day' }), TUESDAY, 'sun');
      expect(view.value).toBeCloseTo(15, 6);
    });

    it('with every day skipped there is nothing to average: a dash and why', () => {
      const fresh = habit('fresh', 'جديدة', { kind: 'count', unit: '', start_day: TUESDAY });
      const view = habitIndicator(fresh, [log(TUESDAY, null, 'vacation')], cfg({ measure: 'avg_7d', period: 'day' }), TUESDAY, 'sun');
      expect(view.value).toBeNull();
      expect(view.text).toBe('—');
      expect(view.reason).toBeTruthy();
      expect(view.completion).toBeNull();
    });
  });

  it('strength: 0.756582 reads 76', () => {
    const view = habitIndicator(ENGLISH, ENGLISH_LOGS, cfg({ measure: 'strength' }), TUESDAY, 'sun', 0.756582);
    expect(view.value).toBe(76);
    expect(view.completion).toBeCloseTo(0.756582, 6);
    expect(view.text).toBe('76');
  });

  it('strength without the server value is computed from the logs', () => {
    const daily = habit('daily', 'تمرين', { start_day: '2026-10-10' });
    const logs = Array.from({ length: 30 }, (_, i) => fromOrdinal(toOrdinal('2026-10-10') + i))
      .filter((day) => day !== '2026-11-09')
      .map((day) => log(day));
    const view = habitIndicator(daily, logs, cfg({ measure: 'strength' }), TUESDAY, 'sun');
    expect(view.value).toBe(76);
  });

  it('a habit that has not started has nothing to show: a dash and why, never 0% or NaN', () => {
    const later = habit('later', 'لاحقة', { start_day: '2026-11-15' });
    const view = habitIndicator(later, [], undefined, TUESDAY, 'sun');
    expect(view.value).toBeNull();
    expect(view.completion).toBeNull();
    expect(view.text).toBe('—');
    expect(view.reason).toContain('2026');
    expect(view.text).not.toMatch(/NaN|0%/);
  });

  it('a small non-zero value is never written 0', () => {
    // 1 of 285 minutes is 0.35%: the percentage says so in words, not 0%.
    const view = habitIndicator(ENGLISH, [log(TUESDAY, 1)], cfg({ measure: 'completion' }), TUESDAY, 'sun');
    expect(view.text).toBe('أقل من 1%');
    const tiny = habit('tiny', 'صغيرة', { kind: 'duration', unit: 'hour', period: 'week', target_per_period: 10, start_day: '2026-11-01' });
    const total = habitIndicator(tiny, [log(TUESDAY, 0.004)], cfg({ measure: 'total' }), TUESDAY, 'sun');
    expect(total.text).toContain('أقل من 0.01');
    expect(total.text).not.toMatch(/(^|\s)0(\s|$)/);
  });

  it('gives a series for the sparkline', () => {
    const view = habitIndicator(ENGLISH, ENGLISH_LOGS, cfg({ measure: 'total', period: 'week', display: 'sparkline' }), TUESDAY, 'sun');
    expect(view.series?.length).toBeGreaterThan(1);
    expect(view.series?.every(Number.isFinite)).toBe(true);
  });

  it('uses the digits setting', () => {
    setDigits('arab');
    expect(habitIndicator(ENGLISH, ENGLISH_LOGS, undefined, TUESDAY, 'sun').text).toBe('٣٠٪');
  });
});
