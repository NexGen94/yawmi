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

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState('loading');

    async function execute() {
      try {
        const result = await fetcherRef.current();
        if (cancelled) return;
        await writeCache(key, result);
        if (cancelled) return;
        setData(result);
        setState('ready');
        setStale(false);
      } catch (error: unknown) {
        if (cancelled) return;
        if (isNetworkError(error)) {
          const cached = await readCache<T>(key);
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
