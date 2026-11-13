// What the focus page and the home page read: the plans (`/v1/focus/plans`) and the sessions of the
// last 28 days (`/v1/focus/sessions`), each with a saved copy like every page. Writing a plan is a
// setting call: it needs the network and is never queued (design 13.1, ruling 22). Sessions are
// events and go through the outbox (`data/events.ts`).
//
// This file is read by the home page, which is in the first bundle: it holds no component.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { api } from '../api/client';
import type { components } from '../api/schema';
import { unwrap } from '../api/unwrap';
import { type QueryResult, useQuery } from '../data/query';
import { fromOrdinal, toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import { isAbortOrTimeout } from '../lib/timeout';
import { listPending, type OutboxEvent } from '../sync/outbox';
import { applyPendingFocus, type FocusPlanOut, type FocusSessionOut } from './calc';

type FocusPlanIO = components['schemas']['FocusPlanIO'];
type FocusPlanPatch = components['schemas']['FocusPlanPatch'];

/** The sessions the page reads: today and the 27 days before it (design 9.5: the last 28 days). */
export const SESSION_WINDOW_DAYS = 28;

export const plansQueryKey = 'focus-plans';
export const sessionsQueryKey = (day: Day): string => `focus-sessions:${day}`;

const SAVE_TIMEOUT_MS = 15_000;
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

/** Why a plan was not saved: no connection (or a timeout), or the server refused it. */
export type PlanResult = { ok: true; plan: FocusPlanOut } | { ok: false; reason: 'offline' | 'rejected' };

async function send(call: () => Promise<FocusPlanOut>): Promise<PlanResult> {
  try {
    return { ok: true, plan: await call() };
  } catch (error: unknown) {
    if (error instanceof TypeError || isAbortOrTimeout(error)) return { ok: false, reason: 'offline' };
    if ((error as { name?: unknown }).name === 'HttpError') return { ok: false, reason: 'rejected' };
    throw error;
  }
}

/** `POST /v1/focus/plans`. Never throws for a network or server refusal. */
export function createPlan(body: FocusPlanIO): Promise<PlanResult> {
  return send(() => api.POST('/v1/focus/plans', { body, signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) }).then(unwrap));
}

/** `PATCH /v1/focus/plans/{id}`: only the fields given change. */
export function patchPlan(id: string, body: FocusPlanPatch): Promise<PlanResult> {
  return send(() =>
    api
      .PATCH('/v1/focus/plans/{plan_id}', { params: { path: { plan_id: id } }, body, signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) })
      .then(unwrap),
  );
}
