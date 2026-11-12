// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAllDrafts, DRAFT_PREFIX } from '../../src/data/drafts';
import {
  clearDraft,
  clearSaved,
  discardDraft,
  hasUnsavedDraft,
  markSaved,
  nextQueueEpoch,
  pruneOldDrafts,
  readDraft,
  readSaved,
  reconcileDrafts,
  writeDraft,
} from '../../src/pages/day/draft';

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const keys = (): string[] => Object.keys(localStorage).sort(byKey);

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('clearAllDrafts', () => {
  it('removes every key that starts with yawmi.draft. and leaves the others', () => {
    localStorage.setItem('yawmi.draft.day.2026-11-10.morning', '{}');
    localStorage.setItem('yawmi.draft.day.2026-11-09.evening', '{}');
    localStorage.setItem('yawmi.draft.something.else', '{}');
    localStorage.setItem('yawmi.drafty', 'kept: not the prefix');
    localStorage.setItem('other', 'kept');
    clearAllDrafts();
    expect(keys()).toEqual(['other', 'yawmi.drafty']);
    expect(DRAFT_PREFIX).toBe('yawmi.draft.');
  });

  it('does not throw when storage refuses (private mode)', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => clearAllDrafts()).not.toThrow();
  });
});

describe('pruneOldDrafts', () => {
  it('keeps today and yesterday and removes older days, whichever the part', () => {
    for (const day of ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']) {
      writeDraft(day, 'morning', { note: day });
      writeDraft(day, 'evening', { note: day });
    }
    localStorage.setItem('other', 'kept');
    pruneOldDrafts('2026-11-10');
    expect(keys()).toEqual([
      'other',
      'yawmi.draft.day.2026-11-09.evening',
      'yawmi.draft.day.2026-11-09.morning',
      'yawmi.draft.day.2026-11-10.evening',
      'yawmi.draft.day.2026-11-10.morning',
    ]);
  });

  it('works across a month boundary', () => {
    writeDraft('2026-10-30', 'morning', {});
    writeDraft('2026-10-31', 'morning', {});
    pruneOldDrafts('2026-11-01');
    expect(keys()).toEqual(['yawmi.draft.day.2026-10-31.morning']);
  });

  it('does not throw when storage refuses', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => pruneOldDrafts('2026-11-10')).not.toThrow();
  });
});

describe('readDraft, writeDraft and clearDraft', () => {
  it('round-trip and clear', () => {
    writeDraft('2026-11-10', 'morning', { note: 'نص' });
    expect(readDraft('2026-11-10', 'morning')).toEqual({ note: 'نص' });
    clearDraft('2026-11-10', 'morning');
    expect(readDraft('2026-11-10', 'morning')).toBeUndefined();
  });

  it('never throw when the storage object itself is unreachable', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(() => writeDraft('2026-11-10', 'morning', {})).not.toThrow();
      expect(readDraft('2026-11-10', 'morning')).toBeUndefined();
      expect(() => clearDraft('2026-11-10', 'morning')).not.toThrow();
      expect(() => pruneOldDrafts('2026-11-10')).not.toThrow();
      expect(() => clearAllDrafts()).not.toThrow();
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    }
  });
});

describe('a saved draft waits for the server', () => {
  const D = '2026-11-10';

  it('markSaved records the event ids, clearSaved forgets them', () => {
    markSaved(D, 'morning', ['a', 'b']);
    expect(readSaved(D, 'morning')).toEqual(['a', 'b']);
    clearSaved(D, 'morning');
    expect(readSaved(D, 'morning')).toEqual([]);
  });

  it('hasUnsavedDraft: a draft nobody queued is unsaved; a queued one is not; none is not', () => {
    expect(hasUnsavedDraft(D, 'evening')).toBe(false);
    writeDraft(D, 'evening', { note: 'x' });
    expect(hasUnsavedDraft(D, 'evening')).toBe(true);
    markSaved(D, 'evening', ['e1']);
    expect(hasUnsavedDraft(D, 'evening')).toBe(false);
  });

  it('reconcile removes the draft once its events are neither waiting nor refused', () => {
    writeDraft(D, 'morning', { note: 'نص' });
    markSaved(D, 'morning', ['e1']);
    reconcileDrafts([D], new Set(), new Set());
    expect(readDraft(D, 'morning')).toBeUndefined();
    expect(readSaved(D, 'morning')).toEqual([]);
  });

  it('reconcile keeps the draft while an event waits', () => {
    writeDraft(D, 'morning', { note: 'نص' });
    markSaved(D, 'morning', ['e1']);
    reconcileDrafts([D], new Set(['e1']), new Set());
    expect(readDraft(D, 'morning')).toEqual({ note: 'نص' });
  });

  it('reconcile ignores a reading that began before the save: it cannot say the save was sent', () => {
    const before = nextQueueEpoch(); // a reading starts...
    writeDraft(D, 'morning', { note: 'نص' });
    markSaved(D, 'morning', ['e1']); // ...the save is queued meanwhile...
    reconcileDrafts([D], new Set(), new Set(), before); // ...and the reading comes back without it
    expect(readDraft(D, 'morning')).toEqual({ note: 'نص' });
    reconcileDrafts([D], new Set(), new Set(), nextQueueEpoch()); // a reading that began after the save
    expect(readDraft(D, 'morning')).toBeUndefined();
  });

  it('reconcile keeps the draft when the server refused an event', () => {
    writeDraft(D, 'morning', { note: 'نص' });
    markSaved(D, 'morning', ['e1', 'e2']);
    reconcileDrafts([D], new Set(), new Set(['e2']));
    expect(readDraft(D, 'morning')).toEqual({ note: 'نص' });
    expect(readSaved(D, 'morning')).toEqual(['e1', 'e2']);
  });

  it('reconcile leaves a draft that was never queued alone', () => {
    writeDraft(D, 'morning', { note: 'نص' });
    reconcileDrafts([D], new Set(), new Set());
    expect(readDraft(D, 'morning')).toEqual({ note: 'نص' });
  });

  it('discardDraft removes the draft and its marker', () => {
    writeDraft(D, 'morning', { note: 'نص' });
    markSaved(D, 'morning', ['e1']);
    discardDraft(D, 'morning');
    expect(keys()).toEqual([]);
  });

  it('prune also removes the markers of old days, and spares the days it is told to keep', () => {
    writeDraft('2026-11-05', 'morning', {});
    markSaved('2026-11-05', 'morning', ['x']);
    writeDraft('2026-11-08', 'evening', { note: 'kept' });
    pruneOldDrafts(D, ['2026-11-08']);
    expect(keys()).toEqual(['yawmi.draft.day.2026-11-08.evening']);
  });

  it('none of these throw when storage refuses', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => reconcileDrafts([D], new Set(), new Set())).not.toThrow();
    expect(hasUnsavedDraft(D, 'morning')).toBe(false);
    expect(readSaved(D, 'morning')).toEqual([]);
    expect(() => discardDraft(D, 'morning')).not.toThrow();
  });
});
