// What the goals page reads: `GET /v1/goals` (the mirror of Notion, with pending edits), and the
// owner's choice of table columns from `GET /v1/settings`. Choosing columns is a settings call, so
// it needs the network (design 13.1 ruling 22).

import { useCallback, useEffect, useState } from 'preact/hooks';

import type { Day } from '../domain/types';
import { onDayChange, todayRiyadh } from '../lib/today';

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import { writeCache } from '../data/cache';
import { type QueryResult, useQuery } from '../data/query';
import { columnsOf, type GoalTable } from './columns';
import type { GoalColumnsIO, GoalsOut, SettingsOut } from './types';

export const goalsQueryKey = 'goals';
export const settingsQueryKey = 'settings';

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

export interface GoalColumns {
  columns: Record<GoalTable, string[]>;
  /** The stored choice is known, so a change can be saved without overwriting the other tables. */
  known: boolean;
  /** The stored choice is still being read. */
  loading: boolean;
  /** Saves the columns of one table (the other two are sent as they are: the server replaces the whole object). */
  save(table: GoalTable, keys: string[]): Promise<boolean>;
}

export function useGoalColumns(): GoalColumns {
  const query = useQuery(settingsQueryKey, () => api.GET('/v1/settings').then(unwrap));
  const [saved, setSaved] = useState<GoalColumnsIO | undefined>(undefined);
  const stored = saved ?? (query.data as SettingsOut | undefined)?.goal_columns;
  const columns = columnsOf(stored);
  const known = query.data !== undefined || saved !== undefined;

  const save = useCallback(
    async (table: GoalTable, keys: string[]): Promise<boolean> => {
      const next = { ...columnsOf(stored), [table]: keys };
      try {
        const result = await api.PATCH('/v1/settings', { body: { goal_columns: next as GoalColumnsIO } });
        const body = unwrap(result);
        setSaved(body.goal_columns ?? (next as GoalColumnsIO));
        // the saved copy answers offline too: a reload without a connection shows the new choice
        void writeCache(settingsQueryKey, body).catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    },
    [stored],
  );

  return { columns, known, loading: !known && query.state === 'loading', save };
}

/** The Riyadh day, moving to the next one at midnight without a reload. */
export function useToday(): Day {
  const [day, setDay] = useState<Day>(() => todayRiyadh());
  useEffect(() => onDayChange(setDay), []);
  return day;
}
