import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  endBreath,
  endFocus,
  logHabit,
  logMood,
  saveJournal,
  setGoalTask,
  startFocus,
} from '../../src/data/events';
import * as outboxModule from '../../src/sync/outbox';
import { closeDb, openDb } from '../../src/sync/outbox';

describe('event helpers', () => {
  beforeEach(() => {
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
  });

  afterEach(() => {
    closeDb();
  });

  it('logHabit(code, { status: "done" }) does not carry value', async () => {
    const id = await logHabit('walk', { status: 'done' });
    expect(typeof id).toBe('string');

    const db = await openDb();
    const event = await db.get('outbox', id);
    expect(event).toBeDefined();
    expect(event?.type).toBe('habit_logged');
    expect(event?.payload).toEqual({
      habit_code: 'walk',
      status: 'done',
    });
    expect(Object.hasOwn(event?.payload as object, 'value')).toBe(false);
  });

  it('logHabit carries value and day when provided', async () => {
    const id = await logHabit('run', { status: 'done', value: 10, day: '2026-11-12' });
    const db = await openDb();
    const event = await db.get('outbox', id);
    expect(event?.type).toBe('habit_logged');
    expect(event?.payload).toEqual({
      habit_code: 'run',
      status: 'done',
      value: 10,
      day: '2026-11-12',
    });
  });

  it('saveJournal enqueues journal_saved event', async () => {
    const answers = {
      enthusiasm: 'عالي',
      gratitude: ['الحمد لله'],
      note: 'يوم جديد',
      planned_minutes: 60,
    };
    const id = await saveJournal('morning', answers, '2026-11-12');

    const db = await openDb();
    const event = await db.get('outbox', id);
    expect(event?.type).toBe('journal_saved');
    expect(event?.payload).toEqual({
      part: 'morning',
      answers,
      day: '2026-11-12',
    });
  });

  it('logMood enqueues mood_logged event', async () => {
    const payload = {
      score: 4,
      feelings: ['calm', 'focused'],
      activities: ['reading'],
      day: '2026-11-12',
    };
    const id = await logMood(payload);

    const db = await openDb();
    const event = await db.get('outbox', id);
    expect(event?.type).toBe('mood_logged');
    expect(event?.payload).toEqual(payload);
  });

  it('setGoalTask enqueues goal_task_set event', async () => {
    const taskId = '01931f3b-0001-7000-8000-000000000001';
    const id = await setGoalTask(taskId, true);

    const db = await openDb();
    const event = await db.get('outbox', id);
    expect(event?.type).toBe('goal_task_set');
    expect(event?.payload).toEqual({
      task_id: taskId,
      done: true,
    });
  });

  it('startFocus enqueues focus_started event', async () => {
    const payload = { planned_minutes: 25, habit_code: 'code', goal_ref: null, plan_id: null };
    const id = await startFocus(payload);

    const db = await openDb();
    const event = await db.get('outbox', id);
    expect(event?.type).toBe('focus_started');
    expect(event?.payload).toEqual(payload);
  });

  it('endFocus enqueues focus_ended event', async () => {
    const payload = {
      actual_minutes: 25,
      focus_rating: 4,
      ended_at: null,
      goal_ref: null,
      habit_code: 'code',
      next_step: null,
      planned_minutes: 25,
      started_at: null,
    };
    const id = await endFocus(payload);

    const db = await openDb();
    const event = await db.get('outbox', id);
    expect(event?.type).toBe('focus_ended');
    expect(event?.payload).toEqual(payload);
  });

  it('endBreath enqueues breath_ended event', async () => {
    const payload = {
      pattern: 'box',
      breaths_per_min: 6,
      duration_seconds: 300,
      feeling: 'calmer' as const,
      completed: true,
      ended_at: null,
      started_at: null,
    };
    const id = await endBreath(payload);

    const db = await openDb();
    const event = await db.get('outbox', id);
    expect(event?.type).toBe('breath_ended');
    expect(event?.payload).toEqual(payload);
  });

  it('every event helper calls scheduleFlush after enqueueing', async () => {
    const scheduleSpy = vi.spyOn(outboxModule, 'scheduleFlush');

    await logHabit('walk', { status: 'done' });
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    await saveJournal('morning', { grateful_for: 'الحمد لله' } as any);
    expect(scheduleSpy).toHaveBeenCalledTimes(2);

    await logMood({ score: 5, day: '2026-11-12' });
    expect(scheduleSpy).toHaveBeenCalledTimes(3);

    await setGoalTask('task-1', true);
    expect(scheduleSpy).toHaveBeenCalledTimes(4);

    await startFocus({ planned_minutes: 25, habit_code: null, goal_ref: null, plan_id: null });
    expect(scheduleSpy).toHaveBeenCalledTimes(5);

    await endFocus({
      actual_minutes: 25,
      focus_rating: null,
      ended_at: null,
      goal_ref: null,
      habit_code: null,
      next_step: null,
      planned_minutes: 25,
      started_at: null,
    });
    expect(scheduleSpy).toHaveBeenCalledTimes(6);

    await endBreath({
      completed: true,
      duration_seconds: 120,
      ended_at: null,
      pattern: 'box',
      started_at: null,
      breaths_per_min: 6,
    });
    expect(scheduleSpy).toHaveBeenCalledTimes(7);
  });

  it('calling logHabit leads to one flush after the delay (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ accepted: 1, errors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await logHabit('walk', { status: 'done' });
      expect(fetchSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4999);
      expect(fetchSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/events');
    } finally {
      vi.useRealTimers();
    }
  });
});
