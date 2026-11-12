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
  todayOut,
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

  it('counts three done of six due, and countsInRing is true for a build habit and false for an abstain one', async () => {
    const { result } = await ready();
    expect(result.current.due).toBe(6);
    expect(result.current.done).toBe(3);
    for (const h of STORY_HABITS) expect(countsInRing(h)).toBe(true);
    expect(countsInRing(habit('no_sugar', 'ترك السكر', { polarity: 'abstain' }))).toBe(false);
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
  const abstain = (over: Partial<ReturnType<typeof habit>> = {}) =>
    habit('no_sugar', 'ترك السكر', { anchor: 'free', polarity: 'abstain', ...over });

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

describe('useHabitsToday: done today for weekly and monthly habits', () => {
  const weekly = habit('week_walk', 'مشي أسبوعي', { period: 'week', target_per_period: 5 });

  it('a weekly habit logged done today is done today although its week target is not reached', async () => {
    const { result } = await ready({
      habits: [weekly],
      logs: [{ habit_code: 'week_walk', day: DAY, status: 'done', value: null }],
    });
    expect(result.current.items[0]?.progress.reached).toBe(false);
    expect(result.current.done).toBe(1);
  });

  it('a weekly habit with nothing logged today is not done', async () => {
    const { result } = await ready({ habits: [weekly], logs: [] });
    expect(result.current.done).toBe(0);
  });
});

describe('useHabitsToday: the ring and the badge with abstain habits', () => {
  const abstain = habit('no_sugar', 'ترك السكر', { polarity: 'abstain' });

  it('leaves an abstain habit out of the ring and the badge: three done of six build habits', async () => {
    const { result } = await ready({ habits: [...STORY_HABITS, abstain] });
    expect(result.current.due).toBe(6);
    expect(result.current.done).toBe(3);
    expect(result.current.badge).toBe(3);
    expect(result.current.items).toHaveLength(7);
  });

  it('a slip today changes neither the ring nor the badge', async () => {
    const { result } = await ready({
      habits: [...STORY_HABITS, abstain],
      logs: [...STORY_LOGS, { habit_code: 'no_sugar', day: DAY, status: 'done', value: null }],
    });
    expect(result.current.due).toBe(6);
    expect(result.current.done).toBe(3);
    expect(result.current.badge).toBe(3);
  });
});

describe('useHabitsToday: the state of each habit', () => {
  it('gives every item its state, from the logs with the outbox over them', async () => {
    const { result } = await ready();
    const byCode = Object.fromEntries(result.current.items.map((i) => [i.habit.code, i.state]));
    // The first three are reached today; english is 25 of 45 and sleep_screen has no log yesterday.
    expect(byCode[WAKE_1.code]).toBe('done');
    expect(byCode[ENGLISH.code]).toBe('late');
    expect(byCode[SLEEP_1.code]).toBe('late');
  });

  it('an abstain habit with a slip yesterday is late, and a clean one is active', async () => {
    const slipped = await ready({
      habits: [habit('no_sugar', 'ترك السكر', { polarity: 'abstain' })],
      logs: [{ habit_code: 'no_sugar', day: '2026-11-09', status: 'done', value: null }],
    });
    expect(slipped.result.current.items[0]?.state).toBe('late');
    slipped.unmount();
    const clean = await ready({ habits: [habit('no_sugar', 'ترك السكر', { polarity: 'abstain' })], logs: [] });
    expect(clean.result.current.items[0]?.state).toBe('active');
  });
});

describe('useHabitsToday: every habit, not only those due', () => {
  const ended = habit('challenge', 'تحدٍّ', { start_day: '2026-10-01', end_day: '2026-10-30' });
  const upcoming = habit('later', 'عادة قادمة', { start_day: '2026-11-15' });
  const archived = habit('old', 'عادة قديمة', { active: false });
  const saturdays = habit('sat', 'يوم السبت', { schedule_kind: 'weekdays', weekday_mask: 64 });

  async function all() {
    const habits = [...STORY_HABITS, ended, upcoming, archived, saturdays];
    routeFetch(fetchMock, { habits, today: todayOut(STORY_HABITS) });
    const hook = renderHook(() => useHabitsToday('all'));
    await waitFor(() => expect(hook.result.current.state).toBe('ready'));
    return hook;
  }

  it('lists the habits that are not due too, each with its state and whether it is due today', async () => {
    const { result } = await all();
    const items = result.current.items;
    expect(items).toHaveLength(10);
    const of = (code: string) => items.find((i) => i.habit.code === code);
    expect(of('challenge')).toMatchObject({ state: 'ended', dueToday: false });
    expect(of('later')).toMatchObject({ state: 'upcoming', dueToday: false });
    expect(of('old')).toMatchObject({ state: 'archived', dueToday: false });
    expect(of('sat')).toMatchObject({ dueToday: false });
    expect(of(WAKE_1.code)).toMatchObject({ dueToday: true });
  });

  it('keeps the ring and the badge on the habits due today', async () => {
    const { result } = await all();
    expect(result.current.due).toBe(6);
    expect(result.current.done).toBe(3);
    expect(result.current.badge).toBe(3);
  });

  it('exposes the logs with the outbox over them, for the day grid', async () => {
    const { result } = await all();
    expect(result.current.logs.some((l) => l.habit_code === 'english' && l.day === '2026-11-08')).toBe(true);
  });
});

describe('useHabitsToday: quick additions and taking back', () => {
  it('add() twice in the same tick queues 30 then 35', async () => {
    const { result } = await ready();
    await act(async () => {
      void result.current.add(ENGLISH.code, 5);
      void result.current.add(ENGLISH.code, 5);
    });
    await waitFor(async () => expect(await listPending()).toHaveLength(2));
    const values = (await listPending()).map((e) => (e.payload as { value?: number }).value);
    expect(values).toEqual([30, 35]);
  });

  it('release() takes back the newest unsent event of the habit, and says false when none is unsent', async () => {
    const { result } = await ready();
    let taken = true;
    await act(async () => {
      await result.current.tick(SLEEP_1.code);
    });
    await act(async () => {
      taken = await result.current.release(SLEEP_1.code);
    });
    expect(taken).toBe(true);
    expect(await listPending()).toHaveLength(0);
    await act(async () => {
      taken = await result.current.release(SLEEP_1.code);
    });
    expect(taken).toBe(false);
  });

  it('marks an item unsent while its event waits in the outbox', async () => {
    const { result } = await ready();
    expect(result.current.items.find((i) => i.habit.code === SLEEP_1.code)?.unsent).toBe(false);
    await act(async () => {
      await result.current.tick(SLEEP_1.code);
    });
    expect(result.current.items.find((i) => i.habit.code === SLEEP_1.code)?.unsent).toBe(true);
  });
});
