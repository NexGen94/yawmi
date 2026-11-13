// What the breathing page computes from the sessions the server holds (design 9.5).

import type { components } from '../api/schema';
import { periodBounds } from '../domain/periods';
import type { Day, WeekStart } from '../domain/types';
import { isNamedStyle, type TestCode } from './patterns';

export type BreathSessionOut = components['schemas']['BreathSessionOut'];

/** The sessions of this week that count for the ring: completed, one of the six styles. The two
 *  tests are not minutes of practice and never enter the total. */
function counted(sessions: readonly BreathSessionOut[], today: Day, weekStart: WeekStart): BreathSessionOut[] {
  const { start, end } = periodBounds(today, 'week', weekStart);
  return sessions.filter((s) => s.completed && isNamedStyle(s.pattern) && s.duration_seconds !== null && s.day >= start && s.day <= end);
}

/** Minutes of the six styles completed in the week of `today`: the sum of the seconds over 60. */
export function weekMinutes(sessions: readonly BreathSessionOut[], today: Day, weekStart: WeekStart): number {
  return counted(sessions, today, weekStart).reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0) / 60;
}

/** The days of that week with at least one counted session, in order. */
export function sessionDays(sessions: readonly BreathSessionOut[], today: Day, weekStart: WeekStart): Day[] {
  return [...new Set(counted(sessions, today, weekStart).map((s) => s.day))].sort((a, b) => a.localeCompare(b));
}

/** How many counted sessions the week holds. */
export function weekSessionCount(sessions: readonly BreathSessionOut[], today: Day, weekStart: WeekStart): number {
  return counted(sessions, today, weekStart).length;
}

/** The mean of the seconds of the tests of one kind the server holds, or `null` when there is none.
 *  A personal number to compare against, not a score. */
export function personalAverage(sessions: readonly BreathSessionOut[], kind: TestCode): number | null {
  const seconds = sessions.filter((s) => s.pattern === kind && s.duration_seconds !== null).map((s) => s.duration_seconds as number);
  if (seconds.length === 0) return null;
  return seconds.reduce((sum, v) => sum + v, 0) / seconds.length;
}
