// Asking the server for a habit that serves a goal: `POST /v1/goals/{ref}/to-habit`. The draft is
// not saved; the editor opens on it (`fromDraft`).

import { api } from '../api/client';
import { isAbortOrTimeout } from '../lib/timeout';
import type { HabitDraft, HabitPeriod } from './types';

export const DRAFT_TIMEOUT_MS = 15_000;

/** What the editor says when no draft came. */
export const DRAFT_FAILED = 'تعذّر اقتراح العادة؛ يمكن المحاولة ثانية';

export type DraftResult = { ok: true; draft: HabitDraft } | { ok: false };

export interface DraftRequest {
  /** An indicator of the plan, for a draft with a numeric target. */
  kpi?: string | null;
  period?: HabitPeriod;
}

/** The suggested habit for the milestone or card `ref`. Never throws: a failure is `{ ok: false }`. */
export async function requestDraft(ref: string, request: DraftRequest = {}): Promise<DraftResult> {
  const period = request.period ?? 'week';
  const body = request.kpi ? { kpi_code: request.kpi, period } : { period };
  try {
    const result = await api.POST('/v1/goals/{ref}/to-habit', {
      params: { path: { ref } },
      body,
      signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
    });
    return result.response.ok && result.data !== undefined ? { ok: true, draft: result.data } : { ok: false };
  } catch (error: unknown) {
    if (error instanceof TypeError || isAbortOrTimeout(error)) return { ok: false };
    throw error;
  }
}
