// The unsent drafts of the journal live in localStorage under one prefix. They are private text, so
// they must leave the device with the session: `logout()` calls clearAllDrafts() once the server
// confirmed it. This file sits in data/ (not in the day page) because the session module is part
// of the first bundle and the day page is lazy. Every storage access is guarded: in a private
// window, or with site data blocked, localStorage can throw.

/** Every key of a draft starts with this. */
export const DRAFT_PREFIX = 'yawmi.draft.';

/** The keys now in localStorage that start with `prefix` (none when storage cannot be read). */
export function draftKeys(prefix: string = DRAFT_PREFIX): string[] {
  const found: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(prefix)) found.push(key);
    }
  } catch {
    return [];
  }
  return found;
}

/** Removes every draft of every day and part. Other keys stay. Never throws. */
export function clearAllDrafts(): void {
  for (const key of draftKeys()) {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage refused: nothing more can be done here
    }
  }
}
