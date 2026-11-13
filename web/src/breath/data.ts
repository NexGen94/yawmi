// What the breathing page reads: `GET /v1/breath/sessions` over the last year, kept as a saved copy
// like every page. Sessions finished in this visit are added by the page until the server holds them.

import { useEffect, useRef } from 'preact/hooks';

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import { type QueryResult, useQuery } from '../data/query';
import { fromOrdinal, toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import type { BreathSessionOut } from './calc';

export const sessionsQueryKey = 'breath-sessions';
/** The server allows 400 days at most; a year is the history the personal means are made of. */
export const HISTORY_DAYS = 365;

export function useBreathSessions(today: Day): QueryResult<BreathSessionOut[]> {
  const from = fromOrdinal(toOrdinal(today) - HISTORY_DAYS + 1);
  const query = useQuery<BreathSessionOut[]>(sessionsQueryKey, () =>
    api
      .GET('/v1/breath/sessions', { params: { query: { from, to: today } } })
      .then(unwrap)
      .then((list) => list.items),
  );
  // The day turned over while the page was open: the range moves with it.
  const first = useRef(today);
  const reload = query.reload;
  useEffect(() => {
    if (first.current === today) return;
    first.current = today;
    reload();
  }, [today, reload]);
  return query;
}

/** The sessions of the server and the ones of this visit the server does not hold yet. */
export function mergeSessions(server: readonly BreathSessionOut[], local: readonly BreathSessionOut[]): BreathSessionOut[] {
  const held = new Set(server.map((s) => s.id));
  return [...server, ...local.filter((s) => !held.has(s.id))];
}
