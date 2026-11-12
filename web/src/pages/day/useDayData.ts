import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { api } from '../../api/client';
import { unwrap } from '../../api/unwrap';
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
import { listPending, listQuarantined, type OutboxEvent, type QuarantinedEvent } from '../../sync/outbox';
import { nextQueueEpoch } from './draft';
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
  /** Today's list of habits is known: from the server, or from the last saved copy. When it is not
   *  (offline, nothing ever saved) the activities say they wait for the connection. */
  habitsKnown: boolean;
  /** No connection: the queries fell back to their copies, or the browser says so. */
  offline: boolean;
  reload(): void;
  /** Today's answer of the server. Not the copy of another day: that only lends its habits. */
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
  /** Events the server refused, kept apart with their reasons. */
  quarantine: QuarantinedEvent[];
  /** The number of the queue reading that `pending` and `quarantine` come from (0: none yet). Only
   *  a reading that began after a save can say that the save was sent. */
  queueEpoch: number;
  refreshPending(): Promise<void>;
}

// `unwrap` (api/unwrap.ts) tells a refusal (HttpError, the error state) from a failed network
// (TypeError, the offline state), the same way on every page.
const fetchToday = (): Promise<TodayOut> => api.GET('/v1/today').then(unwrap);

const fetchJournal = (from: Day, to: Day): Promise<JournalEntryOut[]> =>
  api.GET('/v1/journal', { params: { query: { from, to } } }).then((r) => unwrap(r).entries);

const fetchMood = (day: Day): Promise<MoodLogOut[]> =>
  api.GET('/v1/mood', { params: { query: { from: day, to: day } } }).then((r) => unwrap(r).logs);

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

  // One saved copy per query, not one per day: on a new day without a connection the last copy
  // still lends the list of habits, and what belongs to another day is not shown as today's.
  const today = useQuery<TodayOut>('day/today', fetchToday);
  const journal = useQuery<JournalEntryOut[]>('day/journal', () => fetchJournal(addDays(day, -LOOK_BACK_DAYS), day));
  const mood = useQuery<MoodLogOut[]>('day/mood', () => fetchMood(day));

  const [pending, setPending] = useState<OutboxEvent[]>([]);
  const [quarantine, setQuarantine] = useState<QuarantinedEvent[]>([]);
  const [queueEpoch, setQueueEpoch] = useState(0);
  const applied = useRef(0);
  const refreshPending = useCallback(async (): Promise<void> => {
    const epoch = nextQueueEpoch();
    try {
      const [waiting, refused] = await Promise.all([listPending(), listQuarantined()]);
      if (epoch < applied.current) return; // a later reading already answered
      applied.current = epoch;
      setPending(waiting);
      setQuarantine(refused);
      setQueueEpoch(epoch);
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

  // The day turned over while the page was open: read all three again for the new day.
  const shownDay = useRef(day);
  useEffect(() => {
    if (shownDay.current === day) return;
    shownDay.current = day;
    reloadAll();
  }, [day, reloadAll]);

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
  // Offline, a copy of an earlier day still names the habits; whether they were done is that day's.
  const copyHabits =
    todayData === undefined && today.data !== undefined && today.state === 'offline'
      ? today.data.habits_due.map((h) => ({ ...h, done_today: false, status_today: null, value_today: null }))
      : undefined;
  const habitsDue = todayData?.habits_due ?? copyHabits;
  const state = combineStates(
    [
      { state: today.state, data: todayData },
      { state: journal.state, data: journal.data },
    ],
    { state: mood.state, data: mood.data },
  );

  const habits = useMemo(
    () => (habitsDue ?? []).filter((h) => h.polarity !== 'abstain'),
    [habitsDue],
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
    habitsKnown: habitsDue !== undefined,
    offline: state === 'offline' || (typeof navigator !== 'undefined' && navigator.onLine === false),
    reload: reloadAll,
    today: todayData,
    entries,
    mood: todayMood,
    habits: habits.map((h) => ({ code: h.code, title: h.title_ar })),
    doneCodes,
    pending,
    quarantine,
    queueEpoch,
    refreshPending,
  };
}
