// The settings of the person (`GET` and `PATCH /v1/settings`). Reading keeps a saved copy like every
// page; saving is a settings call: it needs the network and is never queued (design 13.1, ruling 22).
// The server's `digits` is applied the moment it is known.

import { useCallback, useEffect, useState } from 'preact/hooks';

import { api } from '../api/client';
import type { components } from '../api/schema';
import { unwrap } from '../api/unwrap';
import { writeCache } from '../data/cache';
import { type QueryResult, useQuery } from '../data/query';
import { isAbortOrTimeout } from '../lib/timeout';
import { applyDigits } from './digits';

export type SettingsOut = components['schemas']['SettingsOut'];
export type SettingsPatch = components['schemas']['SettingsPatch'];

/** Shared with the goals page, which reads the same copy for its table columns. */
export const settingsQueryKey = 'settings';
const SAVE_TIMEOUT_MS = 15_000;

export interface UseSettings {
  /** The settings as last read or saved. */
  data: SettingsOut | undefined;
  query: QueryResult<SettingsOut>;
  /** Saves the keys of `patch` (the others stay); true when the server took it. Never throws. */
  save(patch: SettingsPatch): Promise<boolean>;
}

export function useSettings(): UseSettings {
  const query = useQuery<SettingsOut>(settingsQueryKey, () => api.GET('/v1/settings').then(unwrap));
  const [saved, setSaved] = useState<SettingsOut | undefined>(undefined);
  // A newer reading replaces what a save laid over the old one.
  useEffect(() => setSaved(undefined), [query.data]);
  const data = saved ?? query.data;

  useEffect(() => {
    if (data !== undefined) applyDigits(data.digits);
  }, [data]);

  const save = useCallback(async (patch: SettingsPatch): Promise<boolean> => {
    try {
      const result = await api.PATCH('/v1/settings', { body: patch, signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) });
      const body = unwrap(result);
      setSaved(body);
      // the saved copy answers offline too: a reload without a connection shows what was saved
      void writeCache(settingsQueryKey, body).catch(() => undefined);
      return true;
    } catch (error: unknown) {
      if (error instanceof TypeError || isAbortOrTimeout(error) || (error as { name?: unknown }).name === 'HttpError') return false;
      throw error;
    }
  }, []);

  return { data, query, save };
}
