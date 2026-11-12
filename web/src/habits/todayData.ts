// What the home page reads for the day, in one round: `GET /v1/today`, `/v1/habits` and the habit
// logs of the last 62 days. They are fetched together so that the page has one state and one saved
// copy (the cache key names the Riyadh day, so a copy never answers for another day).

import { api } from '../api/client';
import type { components } from '../api/schema';
import { unwrap } from '../api/unwrap';
import { fromOrdinal, toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import type { HabitLogOut } from '../data/pending';
import type { HabitOut } from './types';

export type TodayOut = components['schemas']['TodayOut'];

/** The logs a day's progress needs: the longest period (a month) plus a margin for rolling windows. */
export const LOG_WINDOW_DAYS = 62;

export interface TodayBundle {
  day: Day;
  today: TodayOut;
  habits: HabitOut[];
  logs: HabitLogOut[];
}

export const todayQueryKey = (day: Day): string => `habits-today:${day}`;

/** The first day of the 62-day window that ends on `day`. */
export function logsFrom(day: Day): Day {
  return fromOrdinal(toOrdinal(day) - LOG_WINDOW_DAYS);
}

export async function loadTodayBundle(day: Day): Promise<TodayBundle> {
  const [today, habits, logs] = await Promise.all([
    api.GET('/v1/today').then(unwrap),
    api.GET('/v1/habits').then(unwrap),
    api.GET('/v1/habit-logs', { params: { query: { from: logsFrom(day), to: day } } }).then(unwrap),
  ]);
  return { day, today, habits, logs: logs.logs };
}
