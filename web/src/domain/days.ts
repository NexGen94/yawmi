// Calendar days as `YYYY-MM-DD` strings, computed in pure UTC (port of api/yawmi/domain/days.py
// plus the date helpers the rules need). Nothing here reads the browser's time zone: a day is a
// count of days since 1970-01-01 (its "ordinal"), and Date is used only through its UTC methods.

import type { Day } from './types';

const MS_PER_DAY = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// The plan's zones and their fixed offsets in minutes. Asia/Riyadh is UTC+3 with no daylight
// saving, so a constant offset gives the same day as the IANA rules (spec: local day = Riyadh).
const FIXED_OFFSETS: Readonly<Record<string, number>> = { 'Asia/Riyadh': 180 };

export const DEFAULT_TZ = 'Asia/Riyadh';

// An ISO 8601 instant with an explicit zone: `Z` or `±HH:MM`, optional fractional seconds. A naive
// instant would be read in the browser's zone, so it is refused, as the reference does.
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The days since 1970-01-01 of a `YYYY-MM-DD` string; throws on anything else. */
export function toOrdinal(day: Day): number {
  const match = DAY_PATTERN.exec(day);
  if (match) {
    const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const time = new Date(0).setUTCFullYear(year, month - 1, date);
    // Rejects 2027-02-29, month 13 and the like: Date would roll them over silently.
    if (fromOrdinal(time / MS_PER_DAY) === day) return time / MS_PER_DAY;
  }
  throw new RangeError(`not a calendar day (YYYY-MM-DD): ${JSON.stringify(day)}`);
}

/** The `YYYY-MM-DD` string of a day ordinal. */
export function fromOrdinal(ordinal: number): Day {
  const date = new Date(ordinal * MS_PER_DAY);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** `day` plus `days` (negative to go back). */
export function addDays(day: Day, days: number): Day {
  return fromOrdinal(toOrdinal(day) + days);
}

/** Day of the week of an ordinal: 0 = Sunday ... 6 = Saturday, the bit of `weekday_mask`. */
export function weekdayOf(ordinal: number): number {
  return new Date(ordinal * MS_PER_DAY).getUTCDay();
}

/** Months since year 0 of an ordinal (year × 12 + zero-based month), to count whole months. */
export function monthIndexOf(ordinal: number): number {
  const date = new Date(ordinal * MS_PER_DAY);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/** Day of the month (1..31) of an ordinal. */
export function dayOfMonthOf(ordinal: number): number {
  return new Date(ordinal * MS_PER_DAY).getUTCDate();
}

/** Number of days in the month of an ordinal (February of a leap year has 29). */
export function daysInMonthOf(ordinal: number): number {
  const date = new Date(ordinal * MS_PER_DAY);
  date.setUTCMonth(date.getUTCMonth() + 1, 0); // day 0 of next month = last day of this one
  return date.getUTCDate();
}

/** Python's `%`: the result has the sign of the divisor, so -1 mod 7 is 6. */
export function floorMod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * The calendar day `instantIso` falls on in `tz`. The day follows the instant, not the offset it
 * was written with: `2026-11-09T23:30:00+03:00` is 20:30Z, so still 2026-11-09 in Riyadh.
 */
export function dayKey(instantIso: string, tz: string = DEFAULT_TZ): Day {
  const offset = FIXED_OFFSETS[tz];
  if (offset === undefined) throw new RangeError(`unknown tz: ${JSON.stringify(tz)}`);
  const time = INSTANT_PATTERN.test(instantIso) ? Date.parse(instantIso) : Number.NaN;
  if (Number.isNaN(time)) {
    throw new RangeError(`instant must be ISO 8601 with Z or an offset: ${JSON.stringify(instantIso)}`);
  }
  return fromOrdinal(Math.floor((time + offset * 60_000) / MS_PER_DAY));
}
