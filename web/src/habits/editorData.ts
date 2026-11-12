// What the editor needs to know about a habit it opens, in one round: the habit itself, whether it
// has a log (its type is fixed from the first log, task 13), and whether it carries the average
// indicator this editor makes for the «متوسط» type.

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import { fromOrdinal, toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import { listPending } from '../sync/outbox';
import type { HabitOut } from './types';

/** The log route answers for 400 days at most. */
const MAX_LOG_DAYS = 400;

export interface EditorData {
  habit: HabitOut;
  hasLogs: boolean;
  hadAverage: boolean;
}

export const editorQueryKey = (code: string): string => `habit-editor:${code}`;

/** A log of this habit waiting in the outbox: the server does not know it yet, but it will. */
async function hasPendingLog(code: string): Promise<boolean> {
  const events = await listPending().catch(() => []);
  return events.some((event) => (event.payload as { habit_code?: unknown }).habit_code === code);
}

/** The habit `code` with what the editor asks of it, or `null` when no such habit exists. */
export async function loadEditorData(code: string, today: Day): Promise<EditorData | null> {
  const habits = unwrap(await api.GET('/v1/habits'));
  const habit = habits.find((h) => h.code === code);
  if (habit === undefined) return null;
  const from = fromOrdinal(Math.max(toOrdinal(habit.start_day), toOrdinal(today) - (MAX_LOG_DAYS - 1)));
  const [logs, indicators] = await Promise.all([
    api.GET('/v1/habit-logs', { params: { query: { from, to: today, code } } }).then(unwrap),
    // The indicator only decides which type the habit opens as: a failure here is not an average.
    api
      .GET('/v1/indicators')
      .then(unwrap)
      .catch(() => ({ items: [] })),
  ]);
  const hadAverage = indicators.items.some(
    (i) => i.subject_kind === 'habit' && i.subject_ref === code && i.source === 'habit_logs' && i.measure === 'avg_7d',
  );
  return { habit, hasLogs: logs.logs.length > 0 || (await hasPendingLog(code)), hadAverage };
}
