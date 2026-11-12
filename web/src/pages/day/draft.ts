// The unsent draft of a journal. A new version of the installed app reloads every open tab, and a
// long free text must not die with the reload, so each form mirrors itself here while it holds
// words that were not saved. It is per viewer (localStorage), nothing the server sees, and it goes
// when the journal is saved. Storage can be blocked or full: every call swallows that and the page
// simply works without a draft.

import type { Day } from '../../domain/types';
import type { DayPart } from './part';

const PREFIX = 'yawmi.draft.day.';

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
