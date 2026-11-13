// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSession,
  clockText,
  elapsedMinutes,
  elapsedSeconds,
  type FocusSessionState,
  loadEnding,
  loadSession,
  phase,
  recordedMinutes,
  saveEnding,
  saveSession,
} from '../../src/focus/timer';
import { closeDb } from '../../src/sync/outbox';

const T0 = new Date('2026-11-10T09:00:00Z');
const at = (minutes: number, seconds = 0): Date => new Date(T0.getTime() + minutes * 60_000 + seconds * 1000);
const session = (plannedMinutes = 25): FocusSessionState => ({ startedAt: T0.toISOString(), plannedMinutes });

describe('elapsed time comes from the timestamps (design 9.5)', () => {
  it('is the time since startedAt, in minutes', () => {
    expect(elapsedMinutes(session(), at(12))).toBe(12);
    expect(elapsedMinutes(session(), at(0, 30))).toBe(0.5);
  });

  it('does not depend on how often anything ticked: one reading after a long sleep is exact', () => {
    expect(elapsedMinutes(session(), at(31))).toBe(31);
    expect(elapsedSeconds(session(), at(31, 20))).toBe(31 * 60 + 20);
  });

  it('never goes negative when the clock is set back', () => {
    expect(elapsedMinutes(session(), at(-5))).toBe(0);
    expect(elapsedSeconds(session(), at(-5))).toBe(0);
  });
});

describe('phase: running until the planned time, then overflow', () => {
  it('a 25-minute session is running at 24:59 and overflow from 25:00', () => {
    expect(phase(session(25), at(0))).toBe('running');
    expect(phase(session(25), at(24, 59))).toBe('running');
    expect(phase(session(25), at(25))).toBe('overflow');
    expect(phase(session(25), at(31))).toBe('overflow');
  });

  it('a session ended at 31 of 25 records 31 minutes', () => {
    expect(phase(session(25), at(31))).toBe('overflow');
    expect(recordedMinutes(elapsedMinutes(session(25), at(31)))).toBe(31);
  });
});

describe('recordedMinutes', () => {
  it('is whole minutes, to the nearest', () => {
    expect(recordedMinutes(12)).toBe(12);
    expect(recordedMinutes(12.4)).toBe(12);
    expect(recordedMinutes(12.6)).toBe(13);
    expect(recordedMinutes(0.2)).toBe(0);
  });
});

describe('clockText', () => {
  it('writes minutes and seconds with two digits each', () => {
    expect(clockText(0)).toBe('00:00');
    expect(clockText(65)).toBe('01:05');
    expect(clockText(25 * 60)).toBe('25:00');
    expect(clockText(90 * 60 + 9)).toBe('90:09');
  });
});

describe('the running session in kv survives a reload', () => {
  beforeEach(() => {
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
  });

  it('saves, loads and clears the session under focus_session', async () => {
    expect(await loadSession()).toBeNull();
    const s: FocusSessionState = {
      ...session(50),
      goalRef: 'O7',
      habitCode: 'english',
      planId: '00000000-0000-7000-8000-000000000009',
    };
    await saveSession(s);
    expect(await loadSession()).toEqual(s);
    await clearSession();
    expect(await loadSession()).toBeNull();
  });

  it('keeps the moment the session was ended while the wrap-up is open', async () => {
    expect(await loadEnding()).toBeNull();
    await saveEnding('2026-11-10T09:12:00.000Z');
    expect(await loadEnding()).toBe('2026-11-10T09:12:00.000Z');
    await clearSession();
    expect(await loadEnding()).toBeNull();
  });

  it('refuses a stored value that is not a session', async () => {
    const { kvSet } = await import('../../src/data/cache');
    await kvSet('focus_session', { startedAt: 'not a date', plannedMinutes: 25 });
    expect(await loadSession()).toBeNull();
    await kvSet('focus_session', 'x');
    expect(await loadSession()).toBeNull();
  });
});
