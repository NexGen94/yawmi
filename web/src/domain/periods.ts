// Period bounds and day scheduling for habits (port of api/yawmi/domain/periods.py). Pure
// functions on `YYYY-MM-DD` days; the local day is computed elsewhere (`dayKey`).
//
// The `*Ord` variants work on day ordinals (see days.ts) and are what habits.ts uses in its loops;
// the exported string versions are the public API and the ones the vectors call.

import { dayOfMonthOf, daysInMonthOf, floorMod, fromOrdinal, toOrdinal, weekdayOf } from './days';
import type { Day, HabitSpec, Period, PeriodBounds, WeekStart } from './types';

// Day of the week each week start names: 0 = Sunday ... 6 = Saturday.
const WEEK_START_DAY: Readonly<Record<WeekStart, number>> = { sun: 0, mon: 1, sat: 6 };

/** Throws `RangeError` unless `weekStart` is `sat`, `sun` or `mon`. */
export function checkWeekStart(weekStart: string): asserts weekStart is WeekStart {
  if (!Object.hasOwn(WEEK_START_DAY, weekStart)) {
    throw new RangeError(`unknown week start: ${JSON.stringify(weekStart)}`);
  }
}

/** The last day of a challenge lasting `durationDays` days from `start`: start + duration − 1. */
export function endDay(start: Day, durationDays: number): Day {
  if (!Number.isInteger(durationDays) || durationDays < 1) {
    throw new RangeError('a challenge lasts at least one whole day');
  }
  return fromOrdinal(toOrdinal(start) + durationDays - 1);
}

/** Inclusive bounds, as ordinals, of the period that contains the ordinal `day`. */
export function periodBoundsOrd(day: number, period: Period, weekStart: WeekStart): [number, number] {
  checkWeekStart(weekStart);
  if (period === 'day') return [day, day];
  if (period === 'week') {
    const start = day - floorMod(weekdayOf(day) - WEEK_START_DAY[weekStart], 7);
    return [start, start + 6];
  }
  if (period === 'month') {
    const start = day - dayOfMonthOf(day) + 1;
    return [start, start + daysInMonthOf(day) - 1];
  }
  throw new RangeError(`unknown period: ${JSON.stringify(period)}`);
}

/**
 * Start and end (inclusive) of the period that contains `day`:
 * - `day`: the day itself.
 * - `week`: from the latest day matching `weekStart`, seven days.
 * - `month`: the Gregorian month (a leap February has 29 days).
 *
 * `weekStart` is always checked, even for a day or month period.
 */
export function periodBounds(day: Day, period: Period, weekStart: WeekStart): PeriodBounds {
  const [start, end] = periodBoundsOrd(toOrdinal(day), period, weekStart);
  return { start: fromOrdinal(start), end: fromOrdinal(end) };
}

/** A habit's window and schedule as ordinals, parsed once for the loops in habits.ts. */
export interface Schedule {
  start: number;
  /** `Infinity` for an open habit. */
  end: number;
  kind: HabitSpec['scheduleKind'];
  mask: number;
  everyN: number;
  anchor: number;
}

const KINDS: ReadonlySet<string> = new Set(['boolean', 'count', 'duration']);
const PERIODS: ReadonlySet<string> = new Set(['day', 'week', 'month']);
const SCHEDULE_KINDS: ReadonlySet<string> = new Set(['every_day', 'weekdays', 'every_n_days']);

/**
 * Throws `RangeError` for a spec the reference `HabitSpec` would refuse to construct: unknown
 * enums, a weekly or monthly habit not scheduled every day, a target not above zero, a missing or
 * out-of-range weekday mask, `everyN < 2` or no anchor, an end before the start, or a bad day.
 */
export function checkHabitSpec(spec: HabitSpec): void {
  if (!KINDS.has(spec.kind)) throw new RangeError(`unknown habit kind: ${JSON.stringify(spec.kind)}`);
  if (!PERIODS.has(spec.period)) throw new RangeError(`unknown period: ${JSON.stringify(spec.period)}`);
  if (!SCHEDULE_KINDS.has(spec.scheduleKind)) {
    throw new RangeError(`unknown schedule kind: ${JSON.stringify(spec.scheduleKind)}`);
  }
  if (spec.period !== 'day' && spec.scheduleKind !== 'every_day') {
    throw new RangeError('weekly and monthly habits are scheduled every day only');
  }
  if (!(spec.targetPerPeriod > 0)) {
    throw new RangeError('the target per period must be above zero');
  }
  if (
    spec.scheduleKind === 'weekdays' &&
    (spec.weekdayMask === null || !Number.isInteger(spec.weekdayMask) || spec.weekdayMask < 1 || spec.weekdayMask > 127)
  ) {
    throw new RangeError('a weekdays schedule needs a mask between 1 and 127');
  }
  if (
    spec.scheduleKind === 'every_n_days' &&
    (spec.everyN === null || !Number.isInteger(spec.everyN) || spec.everyN < 2 || spec.anchorDay === null)
  ) {
    throw new RangeError('an every-n-days schedule needs an integer n >= 2 and an anchor day');
  }
  const start = toOrdinal(spec.startDay);
  if (spec.anchorDay !== null) toOrdinal(spec.anchorDay);
  if (spec.endDay !== null && toOrdinal(spec.endDay) < start) {
    throw new RangeError('the end day is before the start day');
  }
}

/** The validated spec's window and schedule as ordinals. */
export function scheduleOf(spec: HabitSpec): Schedule {
  checkHabitSpec(spec);
  return {
    start: toOrdinal(spec.startDay),
    end: spec.endDay === null ? Number.POSITIVE_INFINITY : toOrdinal(spec.endDay),
    kind: spec.scheduleKind,
    mask: spec.weekdayMask ?? 0,
    everyN: spec.everyN ?? 1,
    anchor: spec.anchorDay === null ? 0 : toOrdinal(spec.anchorDay),
  };
}

export function isScheduledOrd(day: number, s: Schedule): boolean {
  if (day < s.start || day > s.end) return false;
  if (s.kind === 'every_day') return true;
  if (s.kind === 'weekdays') return (s.mask & (1 << weekdayOf(day))) !== 0;
  if (s.kind === 'every_n_days') return floorMod(day - s.anchor, s.everyN) === 0;
  throw new RangeError(`unknown schedule kind: ${JSON.stringify(s.kind)}`);
}

/**
 * Whether `day` is scheduled for the habit. Days outside `[startDay, endDay]` never are. Inside:
 * `every_day` always; `weekdays` when the day's bit is set in `weekdayMask` (0 = Sunday);
 * `every_n_days` when `(day − anchorDay) mod everyN = 0`, the anchor may lie before or after the
 * start.
 */
export function isScheduled(day: Day, spec: HabitSpec): boolean {
  return isScheduledOrd(toOrdinal(day), scheduleOf(spec));
}
