// The owner's choice of table columns (`GET` and `PATCH /v1/settings`), for the goals page only.
// Choosing columns is a settings call, so it needs the network (design 13.1, ruling 22). It lives
// apart from `data.ts`, which the home page also reads, so the column tables stay out of the first load.

import { useCallback, useState } from 'preact/hooks';

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import { writeCache } from '../data/cache';
import { useQuery } from '../data/query';
import { settingsQueryKey } from '../settings/data';
import { columnsOf, type GoalTable } from './columns';
import type { GoalColumnsIO, SettingsOut } from './types';

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
