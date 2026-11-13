// What the goals pages and the home page read: `GET /v1/goals` (the mirror of Notion, with pending
// edits). The choice of table columns is in `columnsData.ts`: only the goals page needs it.

import { useEffect, useState } from 'preact/hooks';

import type { Day } from '../domain/types';
import { onDayChange, todayRiyadh } from '../lib/today';

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import { type QueryResult, useQuery } from '../data/query';
import type { GoalsOut } from './types';

export const goalsQueryKey = 'goals';

export function useGoals(): QueryResult<GoalsOut> {
  return useQuery(goalsQueryKey, () => api.GET('/v1/goals').then(unwrap));
}

/** Notion has not been copied yet. Only the milestones and the cards are the mirror: the outcomes and
 *  the cycles come from the plan's seed and are there before the first sync, so they do not count. */
export function isEmptyMirror(goals: GoalsOut): boolean {
  return goals.synced_at === null && goals.milestones.length === 0 && goals.cards.length === 0;
}

/** Whether the browser says it is online (and when that changes). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => {
      removeEventListener('online', up);
      removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/** The Riyadh day, moving to the next one at midnight without a reload. */
export function useToday(): Day {
  const [day, setDay] = useState<Day>(() => todayRiyadh());
  useEffect(() => onDayChange(setDay), []);
  return day;
}
