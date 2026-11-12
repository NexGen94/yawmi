import { describe, expect, it } from 'vitest';

import type { components } from '../../src/api/schema';
import {
  applyPendingJournal,
  applyPendingLogs,
  applyPendingMood,
  nextDayValue,
  toDomainLogs,
} from '../../src/data/pending';
import type { OutboxEvent } from '../../src/sync/outbox';

type HabitLogOut = components['schemas']['HabitLogOut'];
type JournalEntryOut = components['schemas']['JournalEntryOut'];
type MoodLogOut = components['schemas']['MoodLogOut'];

describe('nextDayValue', () => {
  it('computes next day value from current value and delta', () => {
    expect(nextDayValue(null, 5)).toBe(5);
    expect(nextDayValue(0, 5)).toBe(5);
    expect(nextDayValue(25, 5)).toBe(30);
    expect(nextDayValue(30, 5)).toBe(35);
  });
});

describe('applyPendingLogs', () => {
  const today = '2026-11-12';

  it('server log with value 25 and pending event with value 30 give 30 (not 55)', () => {
    const serverLogs: HabitLogOut[] = [
      { habit_code: 'read', day: today, value: 25, status: 'done' },
    ];
    const events: OutboxEvent[] = [
      {
        id: '01931f3b-0001-7000-8000-000000000001',
        type: 'habit_logged',
        payload: { habit_code: 'read', status: 'done', value: 30, day: today },
        occurred_at: '2026-11-12T10:00:00Z',
        tz: 'Asia/Riyadh',
      },
    ];

    const result = applyPendingLogs(serverLogs, events, today);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ habit_code: 'read', day: today, value: 30, status: 'done' });
  });

  it('+5 twice from 25 results in 35', () => {
    const serverLogs: HabitLogOut[] = [
      { habit_code: 'read', day: today, value: 25, status: 'done' },
    ];
    const val1 = nextDayValue(25, 5); // 30
    const val2 = nextDayValue(val1, 5); // 35
    expect(val1).toBe(30);
    expect(val2).toBe(35);

    const events: OutboxEvent[] = [
      {
        id: '01931f3b-0001-7000-8000-000000000001',
        type: 'habit_logged',
        payload: { habit_code: 'read', status: 'done', value: val1, day: today },
        occurred_at: '2026-11-12T10:00:00Z',
        tz: 'Asia/Riyadh',
      },
      {
        id: '01931f3b-0002-7000-8000-000000000002',
        type: 'habit_logged',
        payload: { habit_code: 'read', status: 'done', value: val2, day: today },
        occurred_at: '2026-11-12T10:05:00Z',
        tz: 'Asia/Riyadh',
      },
    ];

    const result = applyPendingLogs(serverLogs, events, today);
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe(35);
  });

  it('pending skip after done sets status to skip', () => {
    const serverLogs: HabitLogOut[] = [
      { habit_code: 'walk', day: today, value: 1, status: 'done' },
    ];
    const events: OutboxEvent[] = [
      {
        id: '01931f3b-0001-7000-8000-000000000001',
        type: 'habit_logged',
        payload: { habit_code: 'walk', status: 'skip', day: today },
        occurred_at: '2026-11-12T10:00:00Z',
        tz: 'Asia/Riyadh',
      },
    ];

    const result = applyPendingLogs(serverLogs, events, today);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('skip');
  });

  it('event for another day does not touch today', () => {
    const yesterday = '2026-11-11';
    const serverLogs: HabitLogOut[] = [
      { habit_code: 'walk', day: today, value: 1, status: 'done' },
    ];
    const events: OutboxEvent[] = [
      {
        id: '01931f3b-0001-7000-8000-000000000001',
        type: 'habit_logged',
        payload: { habit_code: 'walk', status: 'skip', day: yesterday },
        occurred_at: '2026-11-11T10:00:00Z',
        tz: 'Asia/Riyadh',
      },
    ];

    const result = applyPendingLogs(serverLogs, events, today);
    const todayLog = result.find((l) => l.day === today);
    const yesterdayLog = result.find((l) => l.day === yesterday);

    expect(todayLog?.status).toBe('done');
    expect(todayLog?.value).toBe(1);
    expect(yesterdayLog?.status).toBe('skip');
  });
});

describe('toDomainLogs', () => {
  it('restricts to habit code and keeps value a number', () => {
    const logs: HabitLogOut[] = [
      { habit_code: 'read', day: '2026-11-10', value: 20, status: 'done' },
      { habit_code: 'walk', day: '2026-11-10', value: 1, status: 'done' },
      { habit_code: 'read', day: '2026-11-11', value: 25, status: 'done' },
      { habit_code: 'read', day: '2026-11-12', value: null, status: 'skip' },
    ];

    const domainLogs = toDomainLogs(logs, 'read');
    expect(domainLogs).toEqual([
      { day: '2026-11-10', value: 20, status: 'done' },
      { day: '2026-11-11', value: 25, status: 'done' },
      { day: '2026-11-12', value: null, status: 'skip' },
    ]);
    expect(typeof domainLogs[0]?.value).toBe('number');
  });
});

describe('applyPendingJournal', () => {
  it('replaces entry for same day and part with the newest pending event', () => {
    const existing: JournalEntryOut[] = [
      {
        day: '2026-11-12',
        part: 'morning',
        answers: { grateful_for: 'قديم', intention: 'قديم' },
        logged_at: '2026-11-12T05:00:00Z',
      },
    ];

    const events: OutboxEvent[] = [
      {
        id: '01931f3b-0001-7000-8000-000000000001',
        type: 'journal_saved',
        payload: {
          part: 'morning',
          answers: { grateful_for: 'أحدث', intention: 'أحدث' },
          day: '2026-11-12',
        },
        occurred_at: '2026-11-12T06:00:00Z',
        tz: 'Asia/Riyadh',
      },
    ];

    const result = applyPendingJournal(existing, events);
    expect(result).toHaveLength(1);
    expect(result[0]?.answers).toEqual({ grateful_for: 'أحدث', intention: 'أحدث' });
    expect(result[0]?.logged_at).toBe('2026-11-12T06:00:00Z');
  });
});

describe('applyPendingMood', () => {
  it('replaces mood log for same day with the newest pending event', () => {
    const existing: MoodLogOut[] = [
      {
        day: '2026-11-12',
        score: 3,
        feelings: ['calm'],
        activities: ['work'],
      },
    ];

    const events: OutboxEvent[] = [
      {
        id: '01931f3b-0001-7000-8000-000000000001',
        type: 'mood_logged',
        payload: {
          day: '2026-11-12',
          score: 5,
          feelings: ['joyful'],
          activities: ['exercise'],
        },
        occurred_at: '2026-11-12T12:00:00Z',
        tz: 'Asia/Riyadh',
      },
    ];

    const result = applyPendingMood(existing, events);
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBe(5);
    expect(result[0]?.feelings).toEqual(['joyful']);
    expect(result[0]?.activities).toEqual(['exercise']);
  });
});
