import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { api } from '../../api/client';
import type { components } from '../../api/schema';
import {
  applyPendingJournal,
  applyPendingLogs,
  applyPendingMood,
  type HabitLogOut,
  type JournalEntryOut,
  type MoodLogOut,
} from '../../data/pending';
import { type QueryResult, type QueryState, useQuery } from '../../data/query';
import type { Day } from '../../domain/types';
import { onDayChange, todayRiyadh } from '../../lib/today';
import { listPending, type OutboxEvent } from '../../sync/outbox';
import { addDays } from './part';

export type TodayOut = components['schemas']['TodayOut'];

/** A habit as the activities of the day know it. */
export interface DayHabit {
  code: string;
  title: string;
}

/** How far back the page reads the journal: «قبل شهر» of «في مثل هذا اليوم». */
const LOOK_BACK_DAYS = 30;
/** While events wait in the queue the page looks again this often, to learn that they were sent. */
const PENDING_POLL_MS = 2000;

export interface DayData {
  day: Day;
  state: QueryState;
  /** The page shows a saved copy: there is no connection and a copy exists. */
  stale: boolean;
  /** No connection: the queries fell back to their copies, or the browser says so. */
  offline: boolean;
  reload(): void;
  today: TodayOut | undefined;
  /** The journal of the last 30 days and today, with the unsent saves laid over it. */
  entries: JournalEntryOut[];
  /** Today's saved mood, with an unsent one laid over it. */
  mood: MoodLogOut | undefined;
  /** The habits of today that can be activities: abstain habits are not (their «done» is a slip). */
  habits: DayHabit[];
  /** Codes of the habits done today, saved or still queued. */
  doneCodes: string[];
  /** The queue, oldest first (the page's own saves are in it until they are sent). */
  pending: OutboxEvent[];
  refreshPending(): Promise<void>;
}

async function fetchToday(): Promise<TodayOut> {
  const { data, response } = await api.GET('/v1/today');
  if (data === undefined) throw new Error(`today: HTTP ${response.status}`);
  return data;
}

async function fetchJournal(from: Day, to: Day): Promise<JournalEntryOut[]> {
  const { data, response } = await api.GET('/v1/journal', { params: { query: { from, to } } });
  if (data === undefined) throw new Error(`journal: HTTP ${response.status}`);
  return data.entries;
}

async function fetchMood(day: Day): Promise<MoodLogOut[]> {
  const { data, response } = await api.GET('/v1/mood', { params: { query: { from: day, to: day } } });
  if (data === undefined) throw new Error(`mood: HTTP ${response.status}`);
  return data.logs;
}

/** The page's state from its queries. A query that is only refreshing (loading again with data in
 *  hand) is ready: the page keeps what it shows instead of flashing skeletons. The mood never
 *  blocks the page: without it the mood scale simply starts empty. */
export function combineStates(
  required: readonly Pick<QueryResult<unknown>, 'state' | 'data'>[],
  mood: Pick<QueryResult<unknown>, 'state' | 'data'>,
): QueryState {
  const effective = required.map((q) => (q.state === 'loading' && q.data !== undefined ? 'ready' : q.state));
  if (effective.includes('error')) return 'error';
  if (effective.includes('loading')) return 'loading';
  if (mood.state === 'loading' && mood.data === undefined) return 'loading';
  if (effective.includes('offline')) return 'offline';
  return 'ready';
}

/** Everything the day page reads: today, the journal and the mood, the unsent queue laid over
 *  them, and the day itself, which turns over at midnight in Riyadh while the page is open. */
export function useDayData(): DayData {
  const [day, setDay] = useState<Day>(() => todayRiyadh());
  useEffect(() => onDayChange(setDay), []);

  const today = useQuery<TodayOut>(`day/today/${day}`, fetchToday);
  const journal = useQuery<JournalEntryOut[]>(`day/journal/${day}`, () => fetchJournal(addDays(day, -LOOK_BACK_DAYS), day));
  const mood = useQuery<MoodLogOut[]>(`day/mood/${day}`, () => fetchMood(day));

  const [pending, setPending] = useState<OutboxEvent[]>([]);
  const refreshPending = useCallback(async (): Promise<void> => {
    try {
      setPending(await listPending());
    } catch {
      // the queue cannot be read: keep what is shown
    }
  }, []);

  // useQuery's reload is stable, so these three keep reloadAll stable too.
  const reloadToday = today.reload;
  const reloadJournal = journal.reload;
  const reloadMood = mood.reload;
  const reloadAll = useCallback((): void => {
    reloadToday();
    reloadJournal();
    reloadMood();
  }, [reloadToday, reloadJournal, reloadMood]);

  useEffect(() => {
    void refreshPending();
    const again = (): void => void refreshPending();
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [refreshPending]);

  // While something waits to be sent, ask the queue again: when it empties the events were sent.
  const waiting = pending.length > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refreshPending(), PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refreshPending]);

  // Events that left the queue (sent, or taken back) change what the server holds: read it again.
  const before = useRef(0);
  useEffect(() => {
    if (pending.length < before.current) reloadAll();
    before.current = pending.length;
  }, [pending.length, reloadAll]);

  const todayData = today.data?.day === day ? today.data : undefined;
  const state = combineStates(
    [
      { state: today.state, data: todayData },
      { state: journal.state, data: journal.data },
    ],
    { state: mood.state, data: mood.data },
  );

  const habits = useMemo(
    () => (todayData?.habits_due ?? []).filter((h) => (h as { polarity?: string }).polarity !== 'abstain'),
    [todayData],
  );

  const entries = useMemo(() => applyPendingJournal(journal.data ?? [], pending), [journal.data, pending]);
  const todayMood = useMemo(
    () => applyPendingMood(mood.data ?? [], pending).find((m) => m.day === day),
    [mood.data, pending, day],
  );
  const doneCodes = useMemo(() => {
    const logs: HabitLogOut[] = habits.flatMap((h) =>
      h.status_today === null ? [] : [{ habit_code: h.code, day, value: h.value_today, status: h.status_today }],
    );
    const codes = new Set(habits.map((h) => h.code));
    return applyPendingLogs(logs, pending, day)
      .filter((l) => l.day === day && l.status === 'done' && codes.has(l.habit_code))
      .map((l) => l.habit_code);
  }, [habits, pending, day]);

  return {
    day,
    state,
    stale: today.stale,
    offline: state === 'offline' || (typeof navigator !== 'undefined' && navigator.onLine === false),
    reload: reloadAll,
    today: todayData,
    entries,
    mood: todayMood,
    habits: habits.map((h) => ({ code: h.code, title: h.title_ar })),
    doneCodes,
    pending,
    refreshPending,
  };
}
