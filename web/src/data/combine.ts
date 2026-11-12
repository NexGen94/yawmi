import type { QueryState } from './query';

export interface Loaded {
  state: QueryState;
  stale: boolean;
}

/** Several queries make one page state: an error shows first, then loading, then no connection (with
 *  a saved copy only if every one that is offline has one), else ready. */
export function combine(...queries: Loaded[]): Loaded {
  if (queries.some((q) => q.state === 'error')) return { state: 'error', stale: false };
  if (queries.some((q) => q.state === 'loading')) return { state: 'loading', stale: false };
  const offline = queries.filter((q) => q.state === 'offline');
  if (offline.length > 0) return { state: 'offline', stale: offline.every((q) => q.stale) };
  return { state: 'ready', stale: false };
}
