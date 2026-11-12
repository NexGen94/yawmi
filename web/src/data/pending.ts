import type { components } from '../api/schema';
import type { Day, HabitLog, LogStatus } from '../domain/types';
import { todayRiyadh } from '../lib/today';
import type { OutboxEvent } from '../sync/outbox';

export type HabitLogOut = components['schemas']['HabitLogOut'];
export type JournalEntryOut = components['schemas']['JournalEntryOut'];
export type MoodLogOut = components['schemas']['MoodLogOut'];

/**
 * Calculates the next day's cumulative value given the current day's value and a delta.
 * `value` in `habit_logged` is the total for the day, not an increment.
 */
export function nextDayValue(valueToday: number | null, delta: number): number {
  return (valueToday ?? 0) + delta;
}

const VALID_LOG_STATUSES: Set<string> = new Set(['done', 'skip', 'vacation', 'missed']);

/**
 * Converts server HabitLogOut records to the domain HabitLog shape used by the habit rules.
 * Restricts to the given habit code, filters out unknown statuses, and ensures `value` is a number or null.
 */
export function toDomainLogs(logs: HabitLogOut[], code: string): HabitLog[] {
  return logs
    .filter((log) => log.habit_code === code && VALID_LOG_STATUSES.has(log.status))
    .map((log) => ({
      day: log.day,
      value: log.value !== null && log.value !== undefined ? Number(log.value) : null,
      status: log.status as LogStatus,
    }));
}

/**
 * Applies pending habit events from the outbox over server habit logs.
 */
export function applyPendingLogs(
  logs: HabitLogOut[],
  events: OutboxEvent[],
  today: Day = todayRiyadh(),
): HabitLogOut[] {
  const map = new Map<string, HabitLogOut>();
  for (const log of logs) {
    map.set(`${log.habit_code}:${log.day}`, { ...log });
  }

  for (const event of events) {
    const eventDay = event.occurred_at ? todayRiyadh(new Date(event.occurred_at)) : today;
    if (event.type === 'habit_logged') {
      const payload = event.payload as {
        habit_code?: string;
        status?: 'done' | 'skip' | 'vacation';
        value?: number | null;
        day?: string | null;
      };
      if (!payload.habit_code) continue;
      const day = payload.day ?? eventDay;
      const status = payload.status ?? 'done';
      const value =
        status === 'done' && payload.value !== undefined && payload.value !== null
          ? Number(payload.value)
          : null;
      map.set(`${payload.habit_code}:${day}`, {
        habit_code: payload.habit_code,
        day,
        status,
        value,
      });
    } else if (event.type === 'habit_skipped') {
      const payload = event.payload as { habit_code?: string; day?: string | null };
      if (!payload.habit_code) continue;
      const day = payload.day ?? eventDay;
      map.set(`${payload.habit_code}:${day}`, {
        habit_code: payload.habit_code,
        day,
        status: 'skip',
        value: null,
      });
    } else if (event.type === 'habit_vacation') {
      const payload = event.payload as { habit_code?: string; day?: string | null };
      if (!payload.habit_code) continue;
      const day = payload.day ?? eventDay;
      map.set(`${payload.habit_code}:${day}`, {
        habit_code: payload.habit_code,
        day,
        status: 'vacation',
        value: null,
      });
    }
  }

  return Array.from(map.values());
}

/**
 * Applies pending journal saved events over server journal entries.
 * Replaces the entry for the same day and part with the newest pending event.
 */
export function applyPendingJournal(
  entries: JournalEntryOut[],
  events: OutboxEvent[],
): JournalEntryOut[] {
  const map = new Map<string, JournalEntryOut>();
  for (const entry of entries) {
    map.set(`${entry.day}:${entry.part}`, { ...entry });
  }

  for (const event of events) {
    if (event.type === 'journal_saved') {
      const payload = event.payload as {
        part?: 'morning' | 'evening';
        answers?: JournalEntryOut['answers'];
        day?: string | null;
      };
      if (!payload.part || !payload.answers) continue;
      const day = payload.day ?? todayRiyadh(new Date(event.occurred_at));
      map.set(`${day}:${payload.part}`, {
        day,
        part: payload.part,
        answers: payload.answers,
        logged_at: event.occurred_at,
      });
    }
  }

  return Array.from(map.values());
}

/**
 * Applies pending mood logged events over server mood logs.
 * Replaces the mood log for the same day with the newest pending event.
 */
export function applyPendingMood(logs: MoodLogOut[], events: OutboxEvent[]): MoodLogOut[] {
  const map = new Map<string, MoodLogOut>();
  for (const log of logs) {
    map.set(log.day, { ...log });
  }

  for (const event of events) {
    if (event.type === 'mood_logged') {
      const payload = event.payload as {
        day?: string | null;
        score?: number;
        feelings?: string[];
        activities?: string[];
      };
      if (payload.score === undefined) continue;
      const day = payload.day ?? todayRiyadh(new Date(event.occurred_at));
      map.set(day, {
        day,
        score: Number(payload.score),
        feelings: payload.feelings ?? [],
        activities: payload.activities ?? [],
      });
    }
  }

  return Array.from(map.values());
}
