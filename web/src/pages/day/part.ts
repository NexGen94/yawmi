import { fromOrdinal, toOrdinal } from '../../domain/days';
import type { Day } from '../../domain/types';

export type DayPart = 'morning' | 'evening';

/** From this hour in Riyadh `/day` opens the evening (design section 3: before 15:00 the morning). */
const EVENING_FROM_HOUR = 15;
const RIYADH_OFFSET_MS = 180 * 60_000;

/** Which side `/day` opens at `now`. The hour is Riyadh's (UTC+3, no daylight saving), never the
 *  browser's own zone. */
export function defaultPart(now: Date = new Date()): DayPart {
  const hour = new Date(now.getTime() + RIYADH_OFFSET_MS).getUTCHours();
  return hour >= EVENING_FROM_HOUR ? 'evening' : 'morning';
}

/** The ISO day `n` days from `day` (negative for the past). */
export function addDays(day: Day, n: number): Day {
  return fromOrdinal(toOrdinal(day) + n);
}
