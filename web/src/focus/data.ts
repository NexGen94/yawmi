// What the focus page and the home page read: the plans (`/v1/focus/plans`) and the sessions of the
// last 28 days (`/v1/focus/sessions`), each with a saved copy like every page. Writing a plan is in
// `pages/focus/plans.ts` (a setting call: it needs the network and is never queued, design 13.1,
// ruling 22), so that it stays out of the first load. Sessions are events (`data/events.ts`).
//
// This file is read by the home page, which is in the first bundle: it holds no component.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import { type QueryResult, useQuery } from '../data/query';
import { fromOrdinal, toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import { listPending, type OutboxEvent } from '../sync/outbox';
import { loadEnding, loadSession } from './timer';
import { applyPendingFocus, type FocusPlanOut, type FocusSessionOut } from './today';

/** The sessions the page reads: today and the 27 days before it (design 9.5: the last 28 days). */
export const SESSION_WINDOW_DAYS = 28;

export const plansQueryKey = 'focus-plans';
export const sessionsQueryKey = (day: Day): string => `focus-sessions:${day}`;

/** How often the outbox is looked at while something waits in it (a session that was just saved). */
export const focusPoll = { pendingMs: 2000 };

/** The active plans of the person. */
export function useFocusPlans(): QueryResult<FocusPlanOut[]> {
  return useQuery<FocusPlanOut[]>(plansQueryKey, () =>
    api
      .GET('/v1/focus/plans')
      .then(unwrap)
      .then((list) => list.items),
  );
}

export interface FocusSessions {
  query: QueryResult<FocusSessionOut[]>;
  /** The server's sessions with the ended ones still in the outbox laid over them. */
  sessions: FocusSessionOut[];
  /** Looks at the outbox again (after a session was queued). */
  refresh(): Promise<void>;
}

/** The sessions of the 28 days that end on `day`. */
export function useFocusSessions(day: Day): FocusSessions {
  const query = useQuery<FocusSessionOut[]>(sessionsQueryKey(day), () =>
    api
      .GET('/v1/focus/sessions', { params: { query: { from: fromOrdinal(toOrdinal(day) - (SESSION_WINDOW_DAYS - 1)), to: day } } })
      .then(unwrap)
      .then((list) => list.items),
  );
  const [pending, setPending] = useState<OutboxEvent[]>([]);
  const pendingRef = useRef<OutboxEvent[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const now = await listPending();
    pendingRef.current = now;
    if (alive.current) setPending(now);
  }, []);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh, day]);

  // While an ended session waits in the outbox, notice when it is sent and read the server again.
  const reload = query.reload;
  const waiting = pending.some((e) => e.type === 'focus_ended');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void listPending()
        .then((now) => {
          const ids = new Set(now.map((e) => e.id));
          const gone = pendingRef.current.some((e) => e.type === 'focus_ended' && !ids.has(e.id));
          pendingRef.current = now;
          if (!alive.current) return;
          setPending(now);
          if (gone) reload();
        })
        .catch(() => undefined);
    }, focusPoll.pendingMs);
    return () => clearInterval(timer);
  }, [waiting, reload]);

  // A reading that arrived after the send already holds the session: the overlay then adds nothing
  // (it skips ids the server has).
  const sessions = useMemo(
    () => (query.data === undefined ? [] : applyPendingFocus(query.data, pending)),
    [query.data, pending],
  );
  return { query, sessions, refresh };
}

/** What the device holds of a session: `running`, or `unsaved` when it was ended and its wrap-up was
 *  left open; null when there is none. Read once; the home page shows it as a way back. */
export function useStoredSession(): 'running' | 'unsaved' | null {
  const [mark, setMark] = useState<'running' | 'unsaved' | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([loadSession(), loadEnding()])
      .then(([session, ending]) => {
        if (alive) setMark(session === null ? null : ending === null ? 'running' : 'unsaved');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return mark;
}
