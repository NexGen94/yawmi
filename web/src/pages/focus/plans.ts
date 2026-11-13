// Writing a plan: a setting call. It needs the network and is never queued (design 13.1, ruling 22).
// Only the focus page imports this file, so it stays out of the first load.

import { api } from '../../api/client';
import type { components } from '../../api/schema';
import { unwrap } from '../../api/unwrap';
import { type QueryResult, useQuery } from '../../data/query';
import type { FocusPlanOut } from '../../focus/today';
import { isAbortOrTimeout } from '../../lib/timeout';

type FocusPlanIO = components['schemas']['FocusPlanIO'];
type FocusPlanPatch = components['schemas']['FocusPlanPatch'];

const SAVE_TIMEOUT_MS = 15_000;

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

export const allPlansQueryKey = 'focus-plans-all';

/** Every plan the server holds, the stopped ones included (`?all=true`): the page lists the stopped
 *  ones apart so that «إيقاف» can be taken back. */
export function useAllFocusPlans(): QueryResult<FocusPlanOut[]> {
  return useQuery<FocusPlanOut[]>(allPlansQueryKey, () =>
    api
      .GET('/v1/focus/plans', { params: { query: { all: true } } })
      .then(unwrap)
      .then((list) => list.items),
  );
}
