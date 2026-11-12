import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  endBreath,
  endFocus,
  logHabit,
  logMood,
  saveJournal,
  setGoalTask,
  startFocus,
} from '../../src/data/events';
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
});
