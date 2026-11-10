// Habit rules: period progress, strength, streak, challenge progress, adherence and goal prefill.
// A line-by-line port of api/yawmi/domain/habits.py, which is the authority; the shared vectors
// prove the two agree. Do not change a rule here without changing the reference first.
//
// Rules common to every function (pinned by the vectors):
// - Logs outside [startDay, endDay] or after `today` are ignored. Logs are sorted (day, then value
//   with null as −1, then status) before they are summed, so the input order cannot change even
//   the last digit of a result.
// - A day's value is the sum of its `done` values. For a boolean habit one or more `done` logs mean
//   1 (capped at 1 a day); for the others a `done` without a value counts 0.
// - A day is "skipped" when it has a `skip` or `vacation` log and no positive progress. Skipped and
//   unscheduled days are neutral: they never lower strength, break a streak or raise what is due.
// - A weekly or monthly period clipped by startDay or endDay has the proportional target
//   min(T, max(1, ceil(T · k / L − 1e-9))), k its scheduled days and L the full period's days (7,
//   or the month's length). A daily period is never proportional.
// - `done ≥ target` and `done ≥ expected` allow a 1e-9 margin for floating-point noise.
//
// How exact the floats are: the sums over days use the compensated (Neumaier) summation that
// Python 3.12+ `sum()` uses, in the same order, so a period's `done` is bit-identical to the
// reference (ten logs of 0.1 give exactly 1). A day's own total is a plain `+=` in both. The other
// operations are IEEE-754 divisions and products in the same order, except strength's
// `0.5 ** x`, where the JS engine and C `pow` may differ in the last bit. So integers, booleans
// and nulls are identical, while a fraction can differ from the reference by a few ulps (the
// vectors allow 1e-9). Callers decide with `reached` and `onTrack`, not `===` on fractions.

import { monthIndexOf, toOrdinal } from './days';
import { checkWeekStart, isScheduledOrd, periodBoundsOrd, scheduleOf, type Schedule } from './periods';
import type {
  ChallengeProgress,
  Day,
  HabitLog,
  HabitSpec,
  Period,
  PeriodProgress,
  WeekStart,
} from './types';

const EPS = 1e-9;
// Strength keeps m = 0.5 ** (sqrt(f) / 13) a day; at f = 1, 30 days in a row give about 0.798.
const STRENGTH_SCALE = 13;
const ROLLING_WINDOW_DAYS: Partial<Record<Period, number>> = { week: 7, month: 30 };
const STATUSES: ReadonlySet<string> = new Set(['done', 'skip', 'vacation', 'missed']);

/** One day's logs, summed. `neutral`: it has a `skip` or `vacation` log. */
interface DayTotal {
  done: number;
  neutral: boolean;
}

type Days = Map<number, DayTotal>;

const isSkipped = (total: DayTotal | undefined): boolean =>
  total !== undefined && total.neutral && total.done <= 0;

const geq = (value: number, bound: number): boolean => value >= bound - EPS;

function doneValue(spec: HabitSpec, log: HabitLog): number {
  if (spec.kind === 'boolean') return 1;
  return log.value === null ? 0 : Math.max(0, log.value);
}

function compareLogs(a: HabitLog, b: HabitLog): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  const va = a.value ?? -1;
  const vb = b.value ?? -1;
  if (va !== vb) return va < vb ? -1 : 1;
  if (a.status !== b.status) return a.status < b.status ? -1 : 1;
  return 0;
}

/** The logs of the window [startDay, min(today, endDay)], summed by day, in a fixed order. */
function aggregate(spec: HabitSpec, s: Schedule, logs: readonly HabitLog[], today: number): Days {
  const days: Days = new Map();
  for (const log of [...logs].sort(compareLogs)) {
    if (!STATUSES.has(log.status)) throw new RangeError(`unknown log status: ${JSON.stringify(log.status)}`);
    const day = toOrdinal(log.day);
    if (day < s.start || day > today || day > s.end) continue;
    let total = days.get(day);
    if (total === undefined) {
      total = { done: 0, neutral: false };
      days.set(day, total);
    }
    if (log.status === 'done') total.done += doneValue(spec, log);
    else if (log.status === 'skip' || log.status === 'vacation') total.neutral = true;
  }
  if (spec.kind === 'boolean') {
    for (const total of days.values()) total.done = Math.min(1, total.done);
  }
  return days;
}

/**
 * The days' totals from `start` to `end`, summed as CPython 3.12+ `sum()` sums floats: Neumaier's
 * compensated summation, the compensation added at the end only when it is non-zero and finite.
 */
function periodDone(days: Days, start: number, end: number): number {
  let sum = 0;
  let compensation = 0;
  for (let day = start; day <= end; day += 1) {
    const total = days.get(day);
    if (total === undefined) continue;
    const x = total.done;
    const next = sum + x;
    compensation += Math.abs(sum) >= Math.abs(x) ? sum - next + x : x - next + sum;
    sum = next;
  }
  return compensation !== 0 && Number.isFinite(compensation) ? sum + compensation : sum;
}

function scheduledDays(s: Schedule, start: number, end: number): number[] {
  const out: number[] = [];
  for (let day = start; day <= end; day += 1) if (isScheduledOrd(day, s)) out.push(day);
  return out;
}

/**
 * The target of the period [start, end]: the habit's own, except a weekly or monthly period
 * clipped by the window (k scheduled days of L), which gets min(T, max(1, ceil(T·k/L − 1e-9))).
 * A period with no scheduled day at all keeps T.
 */
function effectiveTarget(spec: HabitSpec, s: Schedule, start: number, end: number): number {
  const target = spec.targetPerPeriod;
  if (spec.period === 'day') return target;
  const full = end - start + 1;
  const clipped = scheduledDays(s, start, end).length;
  if (clipped === 0 || clipped >= full) return target;
  return Math.min(target, Math.max(1, Math.ceil((target * clipped) / full - EPS)));
}

type PeriodState = 'reached' | 'neutral' | 'missed';

/** Reached; neutral (no scheduled day, or all of them skipped); or missed. */
function periodState(spec: HabitSpec, s: Schedule, days: Days, start: number, end: number): PeriodState {
  const scheduled = scheduledDays(s, start, end);
  if (scheduled.length === 0) return 'neutral';
  if (geq(periodDone(days, start, end), effectiveTarget(spec, s, start, end))) return 'reached';
  if (scheduled.every((day) => isSkipped(days.get(day)))) return 'neutral';
  return 'missed';
}

/**
 * Progress of the period that contains `today`.
 *
 * `expected = target · e / L`: e the scheduled days before today that are not skipped, plus today
 * only if it has a log (no expectation in the morning before logging), L all scheduled days of the
 * period; `onTrack = done ≥ expected`. `needPerDay` spreads what is left over the scheduled days
 * that remain, today always included. A period with no scheduled day expects nothing.
 */
export function periodProgress(
  spec: HabitSpec,
  logs: readonly HabitLog[],
  today: Day,
  weekStart: WeekStart,
): PeriodProgress {
  const s = scheduleOf(spec);
  const now = toOrdinal(today);
  const days = aggregate(spec, s, logs, now);
  const [start, end] = periodBoundsOrd(now, spec.period, weekStart);
  const target = effectiveTarget(spec, s, start, end);
  const done = periodDone(days, start, end);
  const scheduled = scheduledDays(s, start, end);
  let elapsed = 0;
  let remaining = 0;
  for (const day of scheduled) {
    if ((day < now || (day === now && days.has(now))) && !isSkipped(days.get(day))) elapsed += 1;
    if (day >= now) remaining += 1;
  }
  const expected = scheduled.length > 0 ? (target * elapsed) / scheduled.length : 0;
  return {
    done,
    target,
    completion: Math.min(1, done / target),
    reached: geq(done, target),
    expected,
    onTrack: geq(done, expected),
    needPerDay: remaining > 0 ? Math.max(0, target - done) / remaining : 0,
  };
}

/**
 * Habit strength in [0, 1] (shown × 100): an exponential moving average from startDay to
 * yesterday; today joins only if it has a log, and strength freezes after endDay. For each
 * scheduled day that is not skipped: s ← s·m + v·(1 − m), m = 0.5 ** (sqrt(f) / 13).
 *
 * - Daily: f = 1, v = min(1, the day's value / target); a day with no log or `missed` gives 0.
 * - Weekly and monthly: v = min(1, sum of the last L days / target), L = 7 or 30, and
 *   f = min(1, target / L) for boolean and count, f = 1 for duration. The target is always the
 *   full one (rolling windows, no proportional periods).
 *
 * `weekStart` does not change the result (rolling windows); it is still checked.
 */
export function strength(
  spec: HabitSpec,
  logs: readonly HabitLog[],
  today: Day,
  weekStart: WeekStart,
): number {
  const s = scheduleOf(spec);
  checkWeekStart(weekStart);
  const now = toOrdinal(today);
  const days = aggregate(spec, s, logs, now);
  const last = Math.min(days.has(now) ? now : now - 1, s.end);
  const target = spec.targetPerPeriod;
  const window = ROLLING_WINDOW_DAYS[spec.period] ?? 1;
  const frequency = spec.period === 'day' || spec.kind === 'duration' ? 1 : Math.min(1, target / window);
  const keep = 0.5 ** (Math.sqrt(frequency) / STRENGTH_SCALE);
  let score = 0;
  for (let day = s.start; day <= last; day += 1) {
    if (!isScheduledOrd(day, s) || isSkipped(days.get(day))) continue;
    const value = spec.period === 'day' ? (days.get(day)?.done ?? 0) : periodDone(days, day - window + 1, day);
    score = score * keep + Math.min(1, value / target) * (1 - keep);
  }
  return Math.min(1, Math.max(0, score));
}

/**
 * Consecutive reached periods up to the current one. A missed period breaks the streak; a neutral
 * one (all scheduled days skipped, or none scheduled) bridges it without counting. The current
 * period counts if reached and is otherwise neutral. After endDay there is no current period.
 * Before startDay the streak is 0. A clipped weekly or monthly period is judged on its
 * proportional target.
 */
export function streak(spec: HabitSpec, logs: readonly HabitLog[], today: Day, weekStart: WeekStart): number {
  const s = scheduleOf(spec);
  checkWeekStart(weekStart);
  const now = toOrdinal(today);
  if (now < s.start) return 0;
  const days = aggregate(spec, s, logs, now);
  const inProgress = now <= s.end;
  const [firstStart] = periodBoundsOrd(s.start, spec.period, weekStart);
  let [start, end] = periodBoundsOrd(inProgress ? now : s.end, spec.period, weekStart);
  let count = 0;
  let current = inProgress;
  for (;;) {
    const state = periodState(spec, s, days, start, end);
    if (state === 'reached') count += 1;
    else if (state === 'missed' && !current) break;
    if (start <= firstStart) break;
    [start, end] = periodBoundsOrd(start - 1, spec.period, weekStart);
    current = false;
  }
  return count;
}

/**
 * Progress of a challenge (a habit with an endDay); `null` for an open habit.
 * - Daily: reached scheduled days / scheduled days of the window (skipped days stay counted).
 * - Otherwise: reached periods / periods meeting the window, the clipped first and last judged on
 *   their proportional targets.
 * - `remainingDays`: days left including today; the whole window before it starts, 0 after.
 */
export function challengeProgress(
  spec: HabitSpec,
  logs: readonly HabitLog[],
  today: Day,
  weekStart: WeekStart,
): ChallengeProgress | null {
  const s = scheduleOf(spec);
  checkWeekStart(weekStart);
  // `today` is checked before an open habit returns null, so a bad day never passes silently.
  const now = toOrdinal(today);
  if (spec.endDay === null) return null;
  const days = aggregate(spec, s, logs, now);
  let achieved = 0;
  let total = 0;
  if (spec.period === 'day') {
    for (const day of scheduledDays(s, s.start, s.end)) {
      total += 1;
      const value = days.get(day);
      if (value !== undefined && geq(value.done, spec.targetPerPeriod)) achieved += 1;
    }
  } else {
    let [start, end] = periodBoundsOrd(s.start, spec.period, weekStart);
    while (start <= s.end) {
      total += 1;
      if (geq(periodDone(days, start, end), effectiveTarget(spec, s, start, end))) achieved += 1;
      [start, end] = periodBoundsOrd(end + 1, spec.period, weekStart);
    }
  }
  return {
    achieved,
    total,
    completion: total > 0 ? achieved / total : 0,
    remainingDays: Math.max(0, s.end - Math.max(now, s.start) + 1),
  };
}

/**
 * Finished periods reached / finished periods that are not neutral; `null` when no such period
 * has finished. A period finishes when its last day (clipped at endDay) is before `today`.
 */
export function adherence(
  spec: HabitSpec,
  logs: readonly HabitLog[],
  today: Day,
  weekStart: WeekStart,
): number | null {
  const s = scheduleOf(spec);
  checkWeekStart(weekStart);
  const now = toOrdinal(today);
  const days = aggregate(spec, s, logs, now);
  let [start, end] = periodBoundsOrd(s.start, spec.period, weekStart);
  let reached = 0;
  let counted = 0;
  // s.end is Infinity for an open habit, so both comparisons below hold without a special case.
  while (start <= s.end && Math.min(end, s.end) < now) {
    const state = periodState(spec, s, days, start, end);
    if (state === 'reached') reached += 1;
    if (state !== 'neutral') counted += 1;
    [start, end] = periodBoundsOrd(end + 1, spec.period, weekStart);
  }
  return counted > 0 ? reached / counted : null;
}

/**
 * Suggested per-period target for a habit serving a numeric goal:
 * max(1, ceil((goalTarget − current) / periods − 1e-9)), periods counted from the current one to
 * the deadline's, both included (at least one, even past the deadline).
 */
export function goalPrefill(
  goalTarget: number,
  current: number,
  today: Day,
  deadline: Day,
  period: Period,
  weekStart: WeekStart,
): number {
  const [first] = periodBoundsOrd(toOrdinal(today), period, weekStart);
  const [last] = periodBoundsOrd(toOrdinal(deadline), period, weekStart);
  let periods: number;
  if (period === 'day') periods = last - first + 1;
  else if (period === 'week') periods = Math.floor((last - first) / 7) + 1;
  else periods = monthIndexOf(last) - monthIndexOf(first) + 1;
  const perPeriod = (goalTarget - current) / Math.max(1, periods);
  // The reference raises here (ValueError for NaN, OverflowError for infinity) instead of
  // returning NaN or Infinity; so does this port.
  if (!Number.isFinite(perPeriod)) {
    throw new RangeError(`goal and current must be finite numbers: ${goalTarget}, ${current}`);
  }
  return Math.max(1, Math.ceil(perPeriod - EPS));
}
