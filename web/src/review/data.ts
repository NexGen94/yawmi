// What the three tabs of the review read. Each tab is one query with its own saved copy (the key
// names the Riyadh day, so a copy never answers for another day), and the events still in the outbox
// are laid over what the server sent, so a journal or a mood saved without a connection counts.

import { useEffect, useMemo, useState } from 'preact/hooks';

import { api } from '../api/client';
import type { components } from '../api/schema';
import { unwrap } from '../api/unwrap';
import { applyPendingJournal, applyPendingLogs, applyPendingMood, type HabitLogOut, type JournalEntryOut, type MoodLogOut } from '../data/pending';
import { type QueryResult, useQuery } from '../data/query';
import type { Day, WeekStart } from '../domain/types';
import type { HabitOut } from '../habits/types';
import { listPending, type OutboxEvent } from '../sync/outbox';
import { daysBefore } from './mood-stats';
import { weekBounds } from './week';

type InsightOut = components['schemas']['InsightOut'];

/** The firm rule of the plan: the week starts on Sunday (design 13). */
export const WEEK_START: WeekStart = 'sun';
/** The logs the week tab reads: the 62 days before today, as `habits/todayData` reads them for the home
 *  page (a month plus a margin, what a period's progress needs). Kept here, not imported from there:
 *  importing it from this lazy page moved the whole group of rule modules out of the first-load
 *  chunk into one of its own (+108 bytes gzip). `tests/review/data.test.ts` keeps the two equal. */
export const LOG_WINDOW_DAYS = 62;
export const logsFromWeek = (today: Day): Day => daysBefore(today, LOG_WINDOW_DAYS);
/** The journal tab reads this many days back: a half year, at most 400 as the server allows. */
export const JOURNAL_DAYS = 180;

/** Where the journal tab starts reading: the first day of the month that holds the day `JOURNAL_DAYS - 1`
 *  back, so the oldest month it shows is whole (its card counts all of its days). At most 209 days
 *  back, inside the 400 the server allows. */
export const journalFrom = (today: Day): Day => `${daysBefore(today, JOURNAL_DAYS - 1).slice(0, 7)}-01`;

export const weekQueryKey = (today: Day): string => `review-week:${today}`;
export const journalQueryKey = (today: Day): string => `review-journal:${today}`;
export const moodQueryKey = (today: Day): string => `review-mood:${today}`;

/** The events waiting in the outbox, read once when the tab opens. */
function usePending(today: Day): OutboxEvent[] {
  const [pending, setPending] = useState<OutboxEvent[]>([]);
  useEffect(() => {
    let alive = true;
    void listPending()
      .then((events) => alive && setPending(events))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [today]);
  return pending;
}

// ---------- the week ----------

interface WeekBundle {
  today: Day;
  habits: HabitOut[];
  logs: HabitLogOut[];
  journal: JournalEntryOut[];
  /** The stored weekly reviews, newest first. */
  reviews: InsightOut[];
}

async function loadWeek(today: Day): Promise<WeekBundle> {
  const { start } = weekBounds(today, WEEK_START);
  const [habits, logs, journal, reviews] = await Promise.all([
    api.GET('/v1/habits').then(unwrap),
    api.GET('/v1/habit-logs', { params: { query: { from: logsFromWeek(today), to: today } } }).then(unwrap),
    api.GET('/v1/journal', { params: { query: { from: start, to: today } } }).then(unwrap),
    api.GET('/v1/reviews', { params: { query: { kind: 'weekly' } } }).then(unwrap),
  ]);
  return { today, habits, logs: logs.logs, journal: journal.entries, reviews: reviews.items };
}

export interface WeekData {
  query: QueryResult<WeekBundle>;
  habits: HabitOut[];
  logs: HabitLogOut[];
  journal: JournalEntryOut[];
  reviews: InsightOut[];
}

export function useWeekData(today: Day): WeekData {
  const query = useQuery(weekQueryKey(today), () => loadWeek(today));
  const pending = usePending(today);
  const bundle = query.data;
  const derived = useMemo(
    () => ({
      habits: bundle?.habits ?? [],
      logs: bundle === undefined ? [] : applyPendingLogs(bundle.logs, pending, today),
      journal: bundle === undefined ? [] : applyPendingJournal(bundle.journal, pending),
      reviews: bundle?.reviews ?? [],
    }),
    [bundle, pending, today],
  );
  return { query, ...derived };
}

// ---------- the journal ----------

interface JournalBundle {
  journal: JournalEntryOut[];
  mood: MoodLogOut[];
  /** The habits and their logs over the same days: the month cards count the habit days kept. */
  habits: HabitOut[];
  logs: HabitLogOut[];
}

async function loadJournal(today: Day): Promise<JournalBundle> {
  const from = journalFrom(today);
  const [journal, mood, habits, logs] = await Promise.all([
    api.GET('/v1/journal', { params: { query: { from, to: today } } }).then(unwrap),
    api.GET('/v1/mood', { params: { query: { from, to: today } } }).then(unwrap),
    api.GET('/v1/habits').then(unwrap),
    api.GET('/v1/habit-logs', { params: { query: { from, to: today } } }).then(unwrap),
  ]);
  return { journal: journal.entries, mood: mood.logs, habits, logs: logs.logs };
}

export interface JournalData {
  query: QueryResult<JournalBundle>;
  journal: JournalEntryOut[];
  mood: MoodLogOut[];
  habits: HabitOut[];
  logs: HabitLogOut[];
}

export function useJournalData(today: Day): JournalData {
  const query = useQuery(journalQueryKey(today), () => loadJournal(today));
  const pending = usePending(today);
  const bundle = query.data;
  const derived = useMemo(
    () => ({
      journal: bundle === undefined ? [] : applyPendingJournal(bundle.journal, pending),
      mood: bundle === undefined ? [] : applyPendingMood(bundle.mood, pending),
      habits: bundle?.habits ?? [],
      logs: bundle === undefined ? [] : applyPendingLogs(bundle.logs, pending, today),
    }),
    [bundle, pending, today],
  );
  return { query, ...derived };
}

// ---------- the mood ----------

interface MoodBundle {
  habits: HabitOut[];
  logs: HabitLogOut[];
  mood: MoodLogOut[];
}

/** The first day of the calendar year of `day`. */
export const yearStart = (day: Day): Day => `${day.slice(0, 4)}-01-01`;

async function loadMood(today: Day): Promise<MoodBundle> {
  const from = yearStart(today);
  const [habits, logs, mood] = await Promise.all([
    api.GET('/v1/habits').then(unwrap),
    api.GET('/v1/habit-logs', { params: { query: { from, to: today } } }).then(unwrap),
    api.GET('/v1/mood', { params: { query: { from, to: today } } }).then(unwrap),
  ]);
  return { habits, logs: logs.logs, mood: mood.logs };
}

export interface MoodData {
  query: QueryResult<MoodBundle>;
  habits: HabitOut[];
  logs: HabitLogOut[];
  mood: MoodLogOut[];
}

export function useMoodData(today: Day): MoodData {
  const query = useQuery(moodQueryKey(today), () => loadMood(today));
  const pending = usePending(today);
  const bundle = query.data;
  const derived = useMemo(
    () => ({
      habits: bundle?.habits ?? [],
      logs: bundle === undefined ? [] : applyPendingLogs(bundle.logs, pending, today),
      mood: bundle === undefined ? [] : applyPendingMood(bundle.mood, pending),
    }),
    [bundle, pending, today],
  );
  return { query, ...derived };
}
