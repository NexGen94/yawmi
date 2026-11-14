import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { isAbortOrTimeout } from '../lib/timeout';
import { readCache, writeCache } from './cache';

export type QueryState = 'loading' | 'ready' | 'error' | 'offline';

export interface QueryResult<T> {
  data: T | undefined;
  state: QueryState;
  stale: boolean;
  reload(): void;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (isAbortOrTimeout(error)) return true;
  if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: unknown }).status === 0) {
    return true;
  }
  return false;
}

export function useQuery<T>(key: string, fetcher: () => Promise<T>): QueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [state, setState] = useState<QueryState>('loading');
  const [stale, setStale] = useState<boolean>(false);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const stateRef = useRef(state);
  stateRef.current = state;

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  // The connection is back: a page that shows its saved copy asks the server again, so the badge
  // «نسخة محفوظة · بلا اتصال» clears without a reload. So does a page whose first request is still
  // out: it went out offline, and when it fails it would put the saved copy over a live page (the
  // reload cancels it). One place for every page.
  useEffect(() => {
    const onOnline = (): void => {
      if (stateRef.current === 'offline' || stateRef.current === 'loading') reload();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');

    async function execute() {
      try {
        const result = await fetcherRef.current();
        if (cancelled) return;
        setData(result);
        setState('ready');
        setStale(false);
        void writeCache(key, result).catch(() => {});
      } catch (error: unknown) {
        if (cancelled) return;
        if (isNetworkError(error)) {
          let cached: { value: T; savedAt: string } | undefined;
          try {
            cached = await readCache<T>(key);
          } catch {
            cached = undefined;
          }
          if (cancelled) return;
          if (cached !== undefined) {
            setData(cached.value);
            setState('offline');
            setStale(true);
          } else {
            setData(undefined);
            setState('offline');
            setStale(false);
          }
        } else {
          setData(undefined);
          setState('error');
          setStale(false);
        }
      }
    }

    void execute();

    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  return { data, state, stale, reload };
}
