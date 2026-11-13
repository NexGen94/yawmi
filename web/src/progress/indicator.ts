// The progress indicator of a habit (design 9.3). It is the browser's computation over the logs
// (with the outbox over them), so it moves at once with a tap; the goal's indicator comes from the
// server (`goalIndicatorView` only words it). A value that is not there is a dash with its reason,
// never 0% or NaN.

import { fromOrdinal, toOrdinal } from '../domain/days';
import { periodProgress, strength as strengthOf } from '../domain/habits';
import { periodBounds } from '../domain/periods';
import type { Day, HabitLog, HabitSpec, WeekStart } from '../domain/types';
import type { GoalIndicatorValue } from '../goals/types';
import { amount } from '../habits/amount';
import { habitSpecOf } from '../habits/spec';
import type { HabitOut } from '../habits/types';
import type { IndicatorIO } from '../indicators/types';
import { fmt } from '../lib/format';
import { valueNum } from '../lib/value';

export interface IndicatorView {
  /** The number the card shows big; `null` when there is nothing to measure yet. */
  value: number | null;
  /** What `value` is measured against, when there is such a thing. */
  target: number | null;
  /** 0 to 1, for a ring or a bar; `null` when there is no ratio to draw. */
  completion: number | null;
  /** The value in words, in the current digits: «30%», «85 دقيقة», «2 من 5», or a dash. */
  text: string;
  /** Why there is no value, in Arabic. */
  reason?: string;
  /** Points for a sparkline, oldest first. */
  series?: number[];
}

const DASH = '—';
const SERIES_DAYS = 30;
const STRENGTH_DAYS = 14;
const PERIODS_SHOWN = 8;

const none = (reason: string): IndicatorView => ({ value: null, target: null, completion: null, text: DASH, reason });

/** A ratio as a percentage; a ratio above zero is never written «0%». */
export function pctText(ratio: number): string {
  if (!Number.isFinite(ratio)) return DASH;
  if (ratio > 0 && Math.round(ratio * 100) === 0) return `أقل من ${fmt.pct(0.01)}`;
  return fmt.pct(ratio);
}

/** A quantity in the habit's own unit: whole numbers go through the table of counted nouns, the
 *  rest through the value formatter that never rounds a small number to zero. */
function quantity(n: number, habit: Pick<HabitOut, 'kind' | 'unit'>): string {
  if (habit.kind === 'boolean') return Number.isInteger(n) ? fmt.count(n, 'day') : `${valueNum(n)} يوماً`;
  if (habit.kind === 'count' && habit.unit === '') return valueNum(n);
  if (Number.isInteger(n)) return amount(n, habit.unit);
  const counted = fmt.count(n, habit.unit === 'hour' ? 'hour' : habit.unit === 'min' ? 'minute' : 'session');
  const word = counted.slice(fmt.num(n).length + 1);
  return `${valueNum(n)} ${word}`;
}

/** The value of a log in the habit's unit: a yes/no habit counts a done day as one. */
function valueOf(spec: HabitSpec, log: HabitLog): number {
  if (log.status !== 'done') return 0;
  return spec.kind === 'boolean' ? 1 : (log.value ?? 0);
}

/** The logs by day (a day has one log). */
function byDay(logs: readonly HabitLog[]): Map<Day, HabitLog> {
  const days = new Map<Day, HabitLog>();
  for (const log of logs) days.set(log.day, log);
  return days;
}

/** The value of each day from `first` to `last`, a day with no log counting 0. */
function dailyValues(spec: HabitSpec, days: Map<Day, HabitLog>, first: Day, last: Day): number[] {
  const values: number[] = [];
  for (let ord = toOrdinal(first); ord <= toOrdinal(last); ord += 1) {
    const log = days.get(fromOrdinal(ord));
    values.push(log === undefined ? 0 : valueOf(spec, log));
  }
  return values;
}

function completionSeries(spec: HabitSpec, logs: readonly HabitLog[], today: Day, weekStart: WeekStart): number[] | undefined {
  const points: number[] = [];
  let day = today;
  for (let i = 0; i < PERIODS_SHOWN && day >= spec.startDay; i += 1) {
    points.unshift(periodProgress(spec, logs, day, weekStart).completion);
    const bounds = periodBounds(day, spec.period, weekStart);
    day = fromOrdinal(toOrdinal(bounds.start) - 1);
  }
  return points.length > 1 ? points : undefined;
}

function completionView(spec: HabitSpec, logs: readonly HabitLog[], today: Day, weekStart: WeekStart): IndicatorView {
  const progress = periodProgress(spec, logs, today, weekStart);
  return {
    value: progress.completion,
    target: null,
    completion: progress.completion,
    text: pctText(progress.completion),
    series: completionSeries(spec, logs, today, weekStart),
  };
}

/** The first and last day of the period a total is taken over. */
function totalRange(
  spec: HabitSpec,
  period: IndicatorIO['period'],
  today: Day,
  weekStart: WeekStart,
  cycleStart: Day | null,
): [Day, Day] | null {
  switch (period) {
    case 'day':
      return [today, today];
    case 'week':
    case 'month': {
      const { start, end } = periodBounds(today, period, weekStart);
      return [start, end < today ? end : today];
    }
    case 'cycle':
      return cycleStart === null ? null : [cycleStart, today];
    case 'all':
      return [spec.startDay, today];
  }
}

function totalView(
  habit: HabitOut,
  spec: HabitSpec,
  logs: readonly HabitLog[],
  cfg: IndicatorIO,
  today: Day,
  weekStart: WeekStart,
  cycleStart: Day | null,
): IndicatorView {
  const range = totalRange(spec, cfg.period, today, weekStart, cycleStart);
  if (range === null) return none('لا دورة جارية الآن.');
  const first = range[0] < spec.startDay ? spec.startDay : range[0];
  const values = dailyValues(spec, byDay(logs), first, range[1]);
  const total = values.reduce((a, b) => a + b, 0);
  const target = cfg.target ?? null;
  const completion = target !== null && target > 0 ? Math.min(1, total / target) : null;
  const text = target === null ? quantity(total, habit) : `${valueNum(total)} من ${quantity(target, habit)}`;
  return { value: total, target, completion, text, series: values.slice(-SERIES_DAYS) };
}

function averageView(spec: HabitSpec, logs: readonly HabitLog[], cfg: IndicatorIO, today: Day): IndicatorView {
  const size = cfg.measure === 'avg_30d' ? 30 : 7;
  const days = byDay(logs);
  // The window ends today if today has a log, else yesterday; days before the habit began are no days of it.
  const end = days.has(today) ? today : fromOrdinal(toOrdinal(today) - 1);
  const begin = fromOrdinal(toOrdinal(end) - size + 1);
  const first = begin < spec.startDay ? spec.startDay : begin;
  const counted: number[] = [];
  for (let ord = toOrdinal(first); ord <= toOrdinal(end); ord += 1) {
    const log = days.get(fromOrdinal(ord));
    // A skipped day leaves the denominator; a day with no log counts 0.
    if (log !== undefined && (log.status === 'skip' || log.status === 'vacation')) continue;
    counted.push(log === undefined ? 0 : valueOf(spec, log));
  }
  if (counted.length === 0) return none('لا أيام محسوبة في النافذة بعد.');
  const average = counted.reduce((a, b) => a + b, 0) / counted.length;
  const target = cfg.target ?? (spec.period === 'day' ? spec.targetPerPeriod : null);
  const completion = target !== null && target > 0 ? Math.min(1, average / target) : null;
  const shown = Number.isInteger(average) ? fmt.num(average) : valueNum(average);
  const text = target === null ? shown : `${shown} من ${fmt.num(target)}`;
  return { value: average, target, completion, text, series: counted.slice(-SERIES_DAYS) };
}

function strengthView(
  spec: HabitSpec,
  logs: readonly HabitLog[],
  today: Day,
  weekStart: WeekStart,
  given: number | undefined,
): IndicatorView {
  const score = given ?? strengthOf(spec, logs, today, weekStart);
  const series: number[] = [];
  for (let i = STRENGTH_DAYS - 1; i >= 0; i -= 1) {
    const day = fromOrdinal(toOrdinal(today) - i);
    if (day >= spec.startDay) series.push(Math.round(strengthOf(spec, logs, day, weekStart) * 100));
  }
  const shown = Math.round(score * 100);
  return {
    value: shown,
    target: null,
    completion: score,
    text: fmt.num(shown),
    series: series.length > 1 ? series : undefined,
  };
}

/**
 * What the indicator of a habit shows. `cfg` is the stored choice (the default is the completion of
 * the current period). `strength` is the server's `ProgressOut.strength` when the page has it, else
 * it is computed from the logs. `cycleStart` is the first day of the current cycle, for a total over
 * the cycle.
 */
export function habitIndicator(
  habit: HabitOut,
  logs: readonly HabitLog[],
  cfg: IndicatorIO | undefined,
  today: Day,
  weekStart: WeekStart,
  strength?: number,
  cycleStart?: Day | null,
): IndicatorView {
  let spec: HabitSpec;
  try {
    spec = habitSpecOf(habit);
  } catch (error) {
    if (error instanceof RangeError) return none('تعذّر حساب المؤشر.');
    throw error;
  }
  if (spec.startDay > today) return none(`تبدأ العادة في ${fmt.day(spec.startDay)}.`);
  const config: IndicatorIO = cfg ?? {
    subject_kind: 'habit',
    subject_ref: habit.code,
    source: 'habit_logs',
    measure: 'completion',
    period: habit.period,
    display: 'ring',
  };
  switch (config.measure) {
    case 'completion':
      return completionView(spec, logs, today, weekStart);
    case 'total':
      return totalView(habit, spec, logs, config, today, weekStart, cycleStart ?? null);
    case 'avg_7d':
    case 'avg_30d':
      return averageView(spec, logs, config, today);
    case 'strength':
      return strengthView(spec, logs, today, weekStart, strength);
  }
}

const GOAL_REASON: Record<GoalIndicatorValue['source'], string> = {
  milestones: 'لا محطات بعد',
  linked_habits: 'لا عادات مرتبطة بعد',
  tasks: 'لا مهام بعد',
};

/** The indicator of an outcome or a card, as the server computed it (design 9.3): «2 من 5» for
 *  milestones and tasks, a percentage for linked habits. Nothing to measure is a dash and why. */
export function goalIndicatorView(indicator: GoalIndicatorValue): IndicatorView {
  const { value, target, completion, source } = indicator;
  if (value === null || completion === null || !Number.isFinite(value) || !Number.isFinite(completion)) {
    return none(GOAL_REASON[source]);
  }
  const text = source === 'linked_habits' ? pctText(completion) : `${valueNum(value)} من ${valueNum(target ?? value)}`;
  return { value, target, completion, text };
}
