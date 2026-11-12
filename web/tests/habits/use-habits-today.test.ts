// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, renderHook, waitFor } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { countsInRing, polarityOf, pollTimeouts, useHabitsToday } from '../../src/habits/useHabitsToday';
import { clearOutbox, closeDb, listPending } from '../../src/sync/outbox';
import {
  DAY,
  ENGLISH,
  habit,
  NOON_RIYADH,
  routeFetch,
  SLEEP_1,
  STORY_HABITS,
  STORY_LOGS,
  WAKE_1,
} from '../helpers/today-fixtures';

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function ready(options: Parameters<typeof routeFetch>[1] = {}) {
  routeFetch(fetchMock, options);
  const hook = renderHook(() => useHabitsToday());
  await waitFor(() => expect(hook.result.current.state).toBe('ready'));
  return hook;
}

describe('useHabitsToday: the items', () => {
  it('builds one item per habit due, in the server order, with its group, status and value today', async () => {
    const { result } = await ready();
    const items = result.current.items;
    expect(items.map((i) => i.habit.code)).toEqual(STORY_HABITS.map((h) => h.code));
    expect(items.map((i) => i.group)).toEqual(['after_wake', 'after_wake', 'free', 'free', 'free', 'before_sleep']);
    const english = items.find((i) => i.habit.code === ENGLISH.code);
    expect(english?.statusToday).toBe('done');
    expect(english?.valueToday).toBe(25);
    expect(english?.progress.done).toBe(25);
    expect(english?.progress.target).toBe(45);
    expect(english?.progress.reached).toBe(false);
    const sleep = items.find((i) => i.habit.code === SLEEP_1.code);
    expect(sleep?.statusToday).toBeNull();
    expect(sleep?.valueToday).toBeNull();
  });

  it('counts three done of six due, and countsInRing is true for every habit for now', async () => {
    const { result } = await ready();
    expect(result.current.due).toBe(6);
    expect(result.current.done).toBe(3);
    for (const h of STORY_HABITS) expect(countsInRing(h)).toBe(true);
  });

  it('asks for the logs of the last 62 days of the Riyadh day', async () => {
    await ready();
    const urls = fetchMock.mock.calls.map((call) => (call[0] as Request).url);
    const logs = urls.find((u) => u.includes('/v1/habit-logs')) ?? '';
    expect(logs).toContain('from=2026-09-09');
    expect(logs).toContain('to=2026-11-10');
  });
});

describe('useHabitsToday: logging', () => {
  it('tick queues one habit_logged done and the counts move before any reply', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.tick(SLEEP_1.code);
    });
    expect(result.current.done).toBe(4);
    const events = await listPending();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ habit_code: SLEEP_1.code, status: 'done' });
    expect(result.current.last?.eventId).toBe(events[0]?.id);
  });

  it('tick on a duration habit logs the rest of the day target', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.tick(ENGLISH.code);
    });
    const [event] = await listPending();
    expect(event?.payload).toMatchObject({ habit_code: ENGLISH.code, status: 'done', value: 45 });
    expect(result.current.done).toBe(4);
  });

  it('setValue logs the day total, skip and vacation log their status', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.setValue(ENGLISH.code, 30);
      await result.current.skip(SLEEP_1.code);
      await result.current.vacation(WAKE_1.code);
    });
    const events = await listPending();
    expect(events.map((e) => e.payload)).toEqual([
      { habit_code: ENGLISH.code, status: 'done', value: 30 },
      { habit_code: SLEEP_1.code, status: 'skip' },
      { habit_code: WAKE_1.code, status: 'vacation' },
    ]);
    const skipped = result.current.items.find((i) => i.habit.code === SLEEP_1.code);
    expect(skipped?.statusToday).toBe('skip');
    expect(result.current.done).toBe(2);
  });

  it('undo discards a queued event and restores the counts; after it was sent it returns false', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.tick(SLEEP_1.code);
    });
    const id = result.current.last?.eventId ?? '';
    let undone = false;
    await act(async () => {
      undone = await result.current.undo(id);
    });
    expect(undone).toBe(true);
    expect(result.current.done).toBe(3);

    await act(async () => {
      await result.current.tick(SLEEP_1.code);
    });
    const sentId = result.current.last?.eventId ?? '';
    await clearOutbox();
    await act(async () => {
      undone = await result.current.undo(sentId);
    });
    expect(undone).toBe(false);
  });

  it('keeps the logged state when the event is sent and the next load brings it back', async () => {
    const saved = pollTimeouts.pendingMs;
    pollTimeouts.pendingMs = 20;
    try {
      const { result } = await ready();
      await act(async () => {
        await result.current.tick(SLEEP_1.code);
      });
      // the flush happens: the outbox empties, and the server now has the log
      routeFetch(fetchMock, {
        logs: [...STORY_LOGS, { habit_code: SLEEP_1.code, day: DAY, status: 'done', value: null }],
      });
      await clearOutbox();
      await waitFor(() => {
        const urls = fetchMock.mock.calls.filter((call) => (call[0] as Request).url.includes('/v1/habit-logs'));
        expect(urls.length).toBeGreaterThan(1);
      });
      await waitFor(() => expect(result.current.state).toBe('ready'));
      expect(result.current.done).toBe(4);
    } finally {
      pollTimeouts.pendingMs = saved;
    }
  });
});

describe('useHabitsToday: abstain habits', () => {
  const abstain = (over: Record<string, unknown> = {}) =>
    ({ ...habit('no_sugar', 'ترك السكر', { anchor: 'free' }), polarity: 'abstain', ...over }) as ReturnType<typeof habit>;

  it('reads the polarity of a habit, build when it is missing', () => {
    expect(polarityOf(abstain())).toBe('abstain');
    expect(polarityOf(habit('x', 'x'))).toBe('build');
  });

  it('a day without a slip is reached with no status; a slip log makes it not reached with status done', async () => {
    const clean = await ready({ habits: [abstain()], logs: [] });
    expect(clean.result.current.items[0]?.progress.reached).toBe(true);
    expect(clean.result.current.items[0]?.statusToday).toBeNull();
    clean.unmount();

    const slipped = await ready({
      habits: [abstain()],
      logs: [{ habit_code: 'no_sugar', day: DAY, status: 'done', value: null }],
    });
    expect(slipped.result.current.items[0]?.progress.reached).toBe(false);
    expect(slipped.result.current.items[0]?.statusToday).toBe('done');
  });

  it('a skipped day is not reached either, and is told apart from a slip by its status', async () => {
    const { result } = await ready({
      habits: [abstain()],
      logs: [{ habit_code: 'no_sugar', day: DAY, status: 'skip', value: null }],
    });
    expect(result.current.items[0]?.progress.reached).toBe(false);
    expect(result.current.items[0]?.statusToday).toBe('skip');
  });
});
