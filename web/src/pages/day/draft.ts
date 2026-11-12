// The unsent draft of a journal. A new version of the installed app reloads every open tab, and a
// long free text must not die with the reload, so each form mirrors itself here while it holds
// words that were not saved. It is per viewer (localStorage), nothing the server sees. It goes as
// soon as the part is saved, when the day is more than a day old, and at logout (data/drafts.ts).
// Storage can be blocked or full: every call swallows that and the page works without a draft.

import { draftKeys, DRAFT_PREFIX } from '../../data/drafts';
import type { Day } from '../../domain/types';
import type { DayPart } from './part';
import { addDays } from './part';

const PREFIX = `${DRAFT_PREFIX}day.`;
const DAY_KEY = /^(\d{4}-\d{2}-\d{2})\.(?:morning|evening)$/;

const key = (day: Day, part: DayPart): string => `${PREFIX}${day}.${part}`;

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

export function clearDraft(day: Day, part: DayPart): void {
  try {
    localStorage.removeItem(key(day, part));
  } catch {
    // nothing to clear
  }
}

/** Removes the drafts of days before yesterday (Riyadh's `today` is passed in): a draft that old
 *  will not be finished, and it is private text that should not stay on the device. */
export function pruneOldDrafts(today: Day): void {
  const oldest = addDays(today, -1);
  for (const full of draftKeys(PREFIX)) {
    const match = DAY_KEY.exec(full.slice(PREFIX.length));
    if (match === null || (match[1] as string) >= oldest) continue;
    try {
      localStorage.removeItem(full);
    } catch {
      // storage refused
    }
  }
}
