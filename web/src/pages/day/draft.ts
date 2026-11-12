// The unsent draft of a journal. A new version of the installed app reloads every open tab, and a
// long free text must not die with the reload, so each form mirrors itself here while it holds
// words that were not saved. It is per viewer (localStorage), nothing the server sees.
//
// A draft leaves only when the server has the text: saving queues events and records their ids
// next to the draft (`markSaved`); `reconcileDrafts` removes the draft once those events are
// neither waiting in the queue nor refused. A refused save keeps the draft, so the words can be
// restored and sent again. Drafts also go at logout (data/drafts.ts) and, when more than a day
// old, in `pruneOldDrafts`. Storage can be blocked or full: every call swallows that and the page
// works without a draft.

import { DRAFT_PREFIX, draftKeys } from '../../data/drafts';
import type { Day } from '../../domain/types';
import type { DayPart } from './part';
import { addDays } from './part';

const PREFIX = `${DRAFT_PREFIX}day.`;
const SAVED = '.saved';
const DAY_KEY = /^(\d{4}-\d{2}-\d{2})\.(?:morning|evening)(?:\.saved)?$/;
const PARTS: readonly DayPart[] = ['morning', 'evening'];

const key = (day: Day, part: DayPart): string => `${PREFIX}${day}.${part}`;

// A queue reading says «sent» only about events that were already in the queue when the reading
// began. Readings and saves are numbered in one sequence, so a reading that began before a save
// cannot be mistaken for proof that the save was sent. (Memory only: a save from an earlier visit
// counts as 0, and any reading is later than that.)
let sequence = 0;
const savedAt = new Map<string, number>();

/** The number of a queue reading that is about to begin. */
export function nextQueueEpoch(): number {
  sequence += 1;
  return sequence;
}

export function readDraft<T>(day: Day, part: DayPart): T | undefined {
  try {
    const raw = localStorage.getItem(key(day, part));
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeDraft(day: Day, part: DayPart, value: unknown): void {
  try {
    localStorage.setItem(key(day, part), JSON.stringify(value));
  } catch {
    // no draft this time
  }
}

/** Removes the draft itself, not the record of what was queued from it. */
export function clearDraft(day: Day, part: DayPart): void {
  try {
    localStorage.removeItem(key(day, part));
  } catch {
    // nothing to clear
  }
}

/** The ids of the events queued from this draft, until the server has accepted them. */
export function readSaved(day: Day, part: DayPart): string[] {
  try {
    const raw = localStorage.getItem(key(day, part) + SAVED);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** The draft was queued as these events. It stays on the device until `reconcileDrafts` sees the
 *  server accept them. */
export function markSaved(day: Day, part: DayPart, ids: readonly string[]): void {
  savedAt.set(key(day, part), nextQueueEpoch());
  try {
    localStorage.setItem(key(day, part) + SAVED, JSON.stringify(ids));
  } catch {
    // no record: the draft then goes with the next reconcile only if it is never marked
  }
}

/** Forgets what was queued: the draft holds words that are not saved again. */
export function clearSaved(day: Day, part: DayPart): void {
  try {
    localStorage.removeItem(key(day, part) + SAVED);
  } catch {
    // nothing to clear
  }
}

/** The draft and its record, both: the person (or the app) is done with these words. */
export function discardDraft(day: Day, part: DayPart): void {
  clearDraft(day, part);
  clearSaved(day, part);
}

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
const anyFilled = (v: unknown): boolean => Array.isArray(v) && v.some(filled);

/** The draft holds free text that a person wrote: not just a mood, a chosen minute, a moved
 *  priority or a proposal nobody accepted (those are not words to keep a page for). */
function hasText(part: DayPart, draft: Record<string, unknown>): boolean {
  if (part === 'evening') {
    // «تعلّمت» is hidden, and not sent, in the one-minute evening.
    const learned = draft.oneMinute !== true && filled(draft.learned);
    return filled(draft.win) || learned || anyFilled(draft.gratitude) || filled(draft.note);
  }
  const slots = Array.isArray(draft.slots) ? (draft.slots as { title?: unknown; mode?: unknown }[]) : [];
  const own = slots.some((slot) => slot.mode !== 'suggested' && filled(slot.title));
  return own || filled(draft.enthusiasm) || anyFilled(draft.gratitude) || filled(draft.note);
}

/** There are words that no event holds: free text in a draft that was never queued, or was edited
 *  after it was, or whose queued events the server refused (`refusedIds`). */
export function hasUnsavedDraft(day: Day, part: DayPart, refusedIds?: ReadonlySet<string>): boolean {
  const draft = readDraft<Record<string, unknown>>(day, part);
  if (draft === undefined || !hasText(part, draft)) return false;
  const saved = readSaved(day, part);
  return saved.length === 0 || (refusedIds !== undefined && saved.some((id) => refusedIds.has(id)));
}

/** Removes the drafts the server has accepted: those whose events are no longer in the queue and
 *  were not refused. A waiting or refused draft stays, and so does one saved after the reading
 *  `readEpoch` began (see `nextQueueEpoch`). */
export function reconcileDrafts(
  days: readonly Day[],
  pendingIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
  readEpoch: number = Number.POSITIVE_INFINITY,
): void {
  for (const day of days) {
    for (const part of PARTS) {
      const ids = readSaved(day, part);
      if (ids.length === 0) continue;
      if ((savedAt.get(key(day, part)) ?? 0) >= readEpoch) continue;
      if (ids.some((id) => pendingIds.has(id) || refusedIds.has(id))) continue;
      discardDraft(day, part);
    }
  }
}

/** Removes the drafts of days before yesterday (Riyadh's `today` is passed in), with their records,
 *  except the days in `keep`: a draft that old will not be finished, and it is private text that
 *  should not stay on the device. */
export function pruneOldDrafts(today: Day, keep: readonly Day[] = []): void {
  const oldest = addDays(today, -1);
  for (const full of draftKeys(PREFIX)) {
    const match = DAY_KEY.exec(full.slice(PREFIX.length));
    const day = match?.[1];
    if (day === undefined || day >= oldest || keep.includes(day)) continue;
    try {
      localStorage.removeItem(full);
    } catch {
      // storage refused
    }
  }
}
