// Saving a habit from the editor: a direct request (settings are never queued; only logs are), and
// the one place that turns a reply into what the page shows. A habit is created with `POST
// /v1/habits` and changed with `PATCH /v1/habits/{code}` carrying only what changed (`toHabitPatch`).
// An «average» habit also puts its indicator, `avg_7d` over its own logs, after the habit is saved.

import { api } from '../api/client';
import { todayRiyadh } from '../lib/today';
import { isAbortOrTimeout } from '../lib/timeout';
import { type FormErrors, type HabitForm, toHabitIn, toHabitPatch, validate } from './form';
import type { HabitOut } from './types';

/** How long the server has to answer, the reading of a refusal included. */
export const SAVE_TIMEOUT_MS = 15_000;

/** What the page says when the answer did not arrive in time (the habit may or may not be saved). */
export const TIMEOUT_MESSAGE = 'انتهت المهلة؛ يمكن المحاولة ثانية';
/** What the page says beside a save button that cannot act. */
export const OFFLINE_MESSAGE = 'يحتاج اتصالاً';
export const FAILED_MESSAGE = 'تعذّر الحفظ؛ يمكن المحاولة ثانية';

export type SaveResult =
  | { ok: true; habit: HabitOut; /** The habit is saved but its average indicator was not. */ indicator?: 'failed' }
  | {
      ok: false;
      /** `failed`: the server answered with an error that no field explains (5xx, a vanished habit). */
      kind: 'validation' | 'offline' | 'timeout' | 'locked' | 'failed';
      errors?: FormErrors;
    };

export interface SaveOptions {
  /** The habit already has an average indicator of ours: it is put again, or removed if the habit is no longer an average. */
  hadAverage?: boolean;
}

const FIELD_ERROR = 'القيمة غير مقبولة.';
const POLARITY_LOCKED = 'polarity_locked';

interface RefusalBody {
  detail?: unknown;
  errors?: { loc?: unknown[]; type?: unknown }[];
}

const isFormField = (name: unknown, f: HabitForm): name is keyof HabitForm => typeof name === 'string' && name in f;

/** A 4xx reply of the habits routes as a result. */
function refusal(status: number, body: unknown, f: HabitForm): SaveResult {
  const { detail, errors } = (typeof body === 'object' && body !== null ? body : {}) as RefusalBody;
  const message = typeof detail === 'string' && detail !== '' ? detail : FIELD_ERROR;
  if (status === 409) return { ok: false, kind: 'locked', errors: { system: message } };
  if (status === 422) {
    const items = Array.isArray(errors) ? errors : [];
    if (items.some((e) => e.type === POLARITY_LOCKED)) {
      return { ok: false, kind: 'locked', errors: { polarity: message } };
    }
    const fields: FormErrors = {};
    for (const item of items) {
      const name = item.loc?.[1];
      if (isFormField(name, f)) fields[name] = FIELD_ERROR;
    }
    return { ok: false, kind: 'validation', errors: fields };
  }
  return { ok: false, kind: 'failed' };
}

/** `put` the average indicator of a habit: its 7-day average of its own logs against its target. */
async function putAverage(code: string, target: number, signal: AbortSignal): Promise<boolean> {
  const result = await api.PUT('/v1/indicators/{subject_kind}/{subject_ref}', {
    params: { path: { subject_kind: 'habit', subject_ref: code } },
    body: {
      subject_kind: 'habit',
      subject_ref: code,
      source: 'habit_logs',
      measure: 'avg_7d',
      target,
      period: 'day',
      display: 'number',
    },
    signal,
  });
  return result.response.ok;
}

async function removeAverage(code: string, signal: AbortSignal): Promise<void> {
  await api.DELETE('/v1/indicators/{subject_kind}/{subject_ref}', {
    params: { path: { subject_kind: 'habit', subject_ref: code } },
    signal,
  });
}

/** Saves the form: creates the habit, or (with `original`) patches it. Never throws. */
export async function saveHabit(f: HabitForm, original?: HabitOut, options: SaveOptions = {}): Promise<SaveResult> {
  const errors = validate(f, todayRiyadh());
  if (original !== undefined && f.start_day === null) errors.start_day = 'تاريخ البداية مطلوب.';
  if (Object.keys(errors).length > 0) return { ok: false, kind: 'validation', errors };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, kind: 'offline' };

  const signal = AbortSignal.timeout(SAVE_TIMEOUT_MS);
  try {
    let habit: HabitOut;
    if (original === undefined) {
      const created = await api.POST('/v1/habits', { body: toHabitIn(f), signal });
      if (!created.response.ok || created.data === undefined) return refusal(created.response.status, created.error, f);
      habit = created.data;
    } else {
      const patch = toHabitPatch(original, f);
      if (Object.keys(patch).length === 0) {
        habit = original;
      } else {
        const changed = await api.PATCH('/v1/habits/{code}', {
          params: { path: { code: original.code } },
          body: patch,
          signal,
        });
        if (!changed.response.ok || changed.data === undefined) return refusal(changed.response.status, changed.error, f);
        habit = changed.data;
      }
    }
    if (f.measure === 'average') {
      const put = await putAverage(habit.code, f.target_per_period, signal).catch(() => false);
      return put ? { ok: true, habit } : { ok: true, habit, indicator: 'failed' };
    }
    if (options.hadAverage) await removeAverage(habit.code, signal).catch(() => undefined);
    return { ok: true, habit };
  } catch (error: unknown) {
    // A refusal whose body could not be read in time says nothing about the fields: not a 422 of theirs.
    if (isAbortOrTimeout(error)) return { ok: false, kind: 'timeout' };
    if (error instanceof TypeError) return { ok: false, kind: 'offline' };
    throw error;
  }
}
