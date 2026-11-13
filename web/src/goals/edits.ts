// Editing the goals from the detail page (design sections 7.1 and 11): a milestone's done, due date
// and evidence, a card's status, and the log of what waits for Notion. Every edit is a direct request
// that needs a connection (design 13.1, ruling 22); nothing here is queued.

import { useCallback, useState } from 'preact/hooks';

import { api } from '../api/client';
import type { components } from '../api/schema';
import { unwrap } from '../api/unwrap';
import { writeCache } from '../data/cache';
import { useQuery } from '../data/query';
import { isAbortOrTimeout } from '../lib/timeout';
import type { CardFull, GoalEditOut, MilestoneFull } from './types';
import { OFFLINE_NOTE } from '../lib/notes';

type MilestoneEdit = components['schemas']['MilestoneEdit'];

/** How long the server has to answer. */
export const EDIT_TIMEOUT_MS = 15_000;
/** What sits beside a control that cannot act without a connection. */
export { OFFLINE_NOTE };
export const TIMEOUT_MESSAGE = 'انتهت المهلة؛ يمكن المحاولة ثانية';
export const FAILED_MESSAGE = 'تعذّر الحفظ؛ يمكن المحاولة ثانية';

/** An edit that did not happen, with the sentence to show beside the field. */
export class EditError extends Error {}

/** A due date outside the plan (2026-10-31 to 2031-12-31): said here before the request, and by the server after it. */
export const DUE_OUT_OF_RANGE = 'الموعد خارج مدى الخطة (من 2026-10-31 إلى 2031-12-31).';

const REFUSALS: Record<string, string> = {
  due_date_out_of_range: DUE_OUT_OF_RANGE,
  status_unknown: 'حالة ليست بين حالات البطاقات في الخطة.',
  field_not_editable: 'هذا الحقل لا يُعدَّل من يومي.',
};
const NOT_FOUND = 'لم تعد هذه الصفحة في الخطة.';
const NOT_CANCELLABLE = 'لا يمكن إلغاء هذا التعديل الآن.';
const VALUE_REFUSED = 'القيمة غير مقبولة.';

interface Reply {
  response: Response;
  error?: unknown;
}

/** The sentence for a reply that is not a success. */
function refusal({ response, error }: Reply): EditError {
  if (response.status === 404) return new EditError(NOT_FOUND);
  if (response.status === 409) return new EditError(NOT_CANCELLABLE);
  if (response.status === 422) {
    const items = (error as { errors?: { type?: unknown }[] } | undefined)?.errors ?? [];
    for (const item of items) {
      const known = typeof item.type === 'string' ? REFUSALS[item.type] : undefined;
      if (known) return new EditError(known);
    }
    return new EditError(VALUE_REFUSED);
  }
  return new EditError(FAILED_MESSAGE);
}

/** Runs a request with a time limit; a lost network or a timeout becomes an `EditError`. */
async function send<T>(request: (signal: AbortSignal) => Promise<Reply & { data?: T }>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new EditError(OFFLINE_NOTE);
  try {
    const result = await request(AbortSignal.timeout(EDIT_TIMEOUT_MS));
    if (!result.response.ok || result.data === undefined) throw refusal(result);
    return result.data;
  } catch (error: unknown) {
    if (error instanceof EditError) throw error;
    if (isAbortOrTimeout(error)) throw new EditError(TIMEOUT_MESSAGE);
    if (error instanceof TypeError) throw new EditError(OFFLINE_NOTE);
    throw error;
  }
}

/** `PATCH /v1/milestones/{page_id}`: the milestone as it is now shown (the new value, its field pending). */
export function editMilestone(pageId: string, patch: MilestoneEdit): Promise<MilestoneFull> {
  return send((signal) => api.PATCH('/v1/milestones/{page_id}', { params: { path: { page_id: pageId } }, body: patch, signal }));
}

/** `PATCH /v1/cards/{page_id}`. */
export function editCard(pageId: string, status: string): Promise<CardFull> {
  return send((signal) => api.PATCH('/v1/cards/{page_id}', { params: { path: { page_id: pageId } }, body: { status }, signal }));
}

/** `POST /v1/goal-edits/{edit_id}/cancel`: a pending or conflicting edit becomes `cancelled`. */
export function cancelEdit(id: string): Promise<GoalEditOut> {
  return send((signal) => api.POST('/v1/goal-edits/{edit_id}/cancel', { params: { path: { edit_id: id } }, signal }));
}

/** The request that makes an edit again (a conflict is re-made, design 11): one `PATCH` of the same
 *  field with the same value. The server reads the base value anew. */
export function redoEdit(edit: GoalEditOut): Promise<MilestoneFull | CardFull> {
  if (edit.target_kind === 'card') return editCard(edit.page_id, String(edit.new_value ?? ''));
  const patch: MilestoneEdit =
    edit.field === 'done' ? { done: edit.new_value === true } : { [edit.field]: edit.new_value ?? '' };
  return editMilestone(edit.page_id, patch);
}

const LIVE = new Set(['pending', 'applied', 'conflict']);

/** Whether a newer edit of the same field has taken the place of `edit` (then its own buttons are done). */
export function isReplaced(edit: GoalEditOut, all: readonly GoalEditOut[]): boolean {
  return all.some(
    (other) =>
      other.id !== edit.id &&
      other.page_id === edit.page_id &&
      other.field === edit.field &&
      LIVE.has(other.status) &&
      Date.parse(other.created_at) > Date.parse(edit.created_at),
  );
}

export interface GoalEdits {
  items: GoalEditOut[] | undefined;
  state: 'loading' | 'ready' | 'error' | 'offline';
  stale: boolean;
  reload(): void;
  /** Reads the log again without going back to «loading»: the rows stay while it comes. */
  refresh(): Promise<void>;
}

const EDITS_KEY = 'goal-edits';

/** `GET /v1/goal-edits`: the newest first. */
export function useGoalEdits(): GoalEdits {
  const query = useQuery(EDITS_KEY, () => api.GET('/v1/goal-edits').then(unwrap).then((r) => r.items));
  const [fresh, setFresh] = useState<GoalEditOut[] | undefined>(undefined);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const items = unwrap(await api.GET('/v1/goal-edits')).items;
      setFresh(items);
      void writeCache(EDITS_KEY, items).catch(() => undefined);
    } catch {
      // the rows on screen stay; the next load tells the truth
    }
  }, []);
  return { items: fresh ?? query.data, state: query.state, stale: query.stale, reload: query.reload, refresh };
}
