// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAllDrafts, DRAFT_PREFIX } from '../../src/data/drafts';
import { clearDraft, pruneOldDrafts, readDraft, writeDraft } from '../../src/pages/day/draft';

const keys = (): string[] => Object.keys(localStorage).sort();

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
