// The habits due today, with their progress, and the one-tap ways to log them. Used by the home page
// (task 7) and the habits page (task 11).
//
// What the screen shows is the server's data with the outbox laid over it (`applyPendingLogs`), so a
// tap is visible at once, before any answer from the network. Progress is computed in the browser
// from the logs with `periodProgress` (the same rules as the server), never taken from the server's
// `period_progress`, because that one cannot know the events still waiting in the outbox.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { type QueryState, useQuery } from '../data/query';
import { applyPendingLogs, nextDayValue, toDomainLogs } from '../data/pending';
import { logHabit, type LogHabitInput } from '../data/events';
import { periodProgress } from '../domain/habits';
import type { Day, HabitSpec, PeriodProgress } from '../domain/types';
import { onDayChange, todayRiyadh } from '../lib/today';
import { discard, listPending, type OutboxEvent } from '../sync/outbox';
import { habitSpecOf } from './spec';
import { loadTodayBundle, type TodayBundle, type TodayOut, todayQueryKey } from './todayData';
import type { HabitOut, HabitUnit } from './types';

export type HabitGroup = 'after_wake' | 'free' | 'before_sleep';

export interface HabitTodayItem {
  habit: HabitOut;
  /** Progress of the current period (day, week or month), from the logs with the outbox over them. */
  progress: PeriodProgress;
  /** Today's log status, or null when nothing is logged today. A `missed` log counts as nothing. */
  statusToday: 'done' | 'skip' | 'vacation' | null;
  /** Today's value when today's log is a `done` with a value. */
  valueToday: number | null;
  group: HabitGroup;
  /** Today's log for this habit is still in the outbox: a tap on the done row can take it back. */
  unsent?: boolean;
}

/** The last thing the person logged, for the «تراجع» note. */
export interface LoggedEvent {
  eventId: string;
  code: string;
  title: string;
  status: 'done' | 'skip' | 'vacation';
}

/** Mutable for tests only. */
export const pollTimeouts = { pendingMs: 2000 };

/** The firm rule `week start = Sunday` of the plan (design section 13). */
const WEEK_START = 'sun';

export type Polarity = 'build' | 'abstain';

/**
 * `abstain` or `build`. The generated `HabitOut` has no `polarity` yet (the settings task adds it
 * to the contract); a habit without the field is a build habit, as the rules treat it.
 */
export function polarityOf(habit: HabitOut): Polarity {
  return (habit as { polarity?: unknown }).polarity === 'abstain' ? 'abstain' : 'build';
}

/**
 * Whether the habit is counted in the ring and in «n من m». Always true for now; the habits task
 * makes abstain habits return false (design 4.1 and 9.6).
 */
export function countsInRing(_habit: HabitOut): boolean {
  return true;
}

/**
 * «نظيف اليوم»: an abstain habit with nothing logged today whose day is kept. Never `reached`
 * alone: a skipped, vacation or unscheduled day is not reached either, and is not a slip, so
 * the status tells them apart (a slip is `statusToday === 'done'`).
 */
export function isCleanToday(item: HabitTodayItem): boolean {
  return item.statusToday === null && item.progress.reached;
}

/** Done for today. A daily habit is done when its day target is reached; a weekly or monthly one
 *  also when it was logged done today (its period target is for the whole period). An abstain habit
 *  is done for the day unless a slip is logged today (the controller's ruling for the ring). */
export function isDoneToday(item: HabitTodayItem): boolean {
  if (polarityOf(item.habit) === 'abstain') return item.statusToday !== 'done';
  if (item.habit.period === 'day') return item.progress.reached;
  return item.progress.reached || item.statusToday === 'done';
}

function specOf(habit: HabitOut, day: Day): HabitSpec {
  const spec = habitSpecOf(habit, day);
  return polarityOf(habit) === 'abstain' ? { ...spec, polarity: 'abstain' } : spec;
}

const HABIT_EVENTS: ReadonlySet<string> = new Set(['habit_logged', 'habit_skipped', 'habit_vacation']);

/** The events of a habit's log for `day` that are still in the outbox. */
export function unsentFor(code: string, unsent: OutboxEvent[], day: Day): OutboxEvent[] {
  return unsent.filter((event) => {
    if (!HABIT_EVENTS.has(event.type)) return false;
    const payload = event.payload as { habit_code?: string; day?: string | null };
    return payload.habit_code === code && (payload.day ?? todayRiyadh(new Date(event.occurred_at))) === day;
  });
}

/** Builds the items for the habits due. `sent` are events the outbox already sent that the loaded
 *  data may not hold yet; `unsent` are the ones still waiting. Both are laid over the logs. */
export function buildItems(bundle: TodayBundle, sent: OutboxEvent[], unsent: OutboxEvent[], day: Day): HabitTodayItem[] {
  const logs = applyPendingLogs(bundle.logs, [...sent, ...unsent], day);
  const byCode = new Map(bundle.habits.map((h) => [h.code, h]));
  const items: HabitTodayItem[] = [];
  for (const due of bundle.today.habits_due) {
    const habit = byCode.get(due.code);
    if (habit === undefined) continue;
    let progress: PeriodProgress;
    try {
      progress = periodProgress(specOf(habit, day), toDomainLogs(logs, habit.code), day, WEEK_START);
    } catch (error) {
      // A habit the rules refuse is left out rather than breaking the page.
      if (error instanceof RangeError) continue;
      throw error;
    }
    const log = logs.find((l) => l.habit_code === habit.code && l.day === day);
    const statusToday = log?.status === 'done' || log?.status === 'skip' || log?.status === 'vacation' ? log.status : null;
    const valueToday = log?.status === 'done' && log.value !== null && log.value !== undefined ? Number(log.value) : null;
    items.push({
      habit,
      progress,
      statusToday,
      valueToday,
      group: habit.anchor,
      unsent: unsentFor(habit.code, unsent, day).length > 0,
    });
  }
  return items;
}

/** A daily need in the habit's own steps: whole minutes, sessions or times, and halves of an hour.
 *  Always rounded up, so a share is never fractional and never short. */
export function roundUpNeed(n: number, unit: HabitUnit): number {
  if (unit === 'hour') return Math.ceil(n * 2 - 1e-9) / 2;
  return Math.ceil(n - 1e-9);
}

/** What a tap on the check mark logs: yes/no habits `done`; counts and durations the day's share
 *  (the rest of the target for a daily one, today's part of the need for a weekly one), in whole
 *  units. `valueToday` overrides the rendered value with the latest one the person logged. */
export function tickInput(item: HabitTodayItem, valueToday: number | null = item.valueToday): LogHabitInput | null {
  if (polarityOf(item.habit) === 'abstain' || item.habit.kind === 'boolean') return { status: 'done' };
  const share = roundUpNeed(item.progress.needPerDay, item.habit.unit);
  if (!(share > 0)) return null;
  return { status: 'done', value: nextDayValue(valueToday, share) };
}

export interface UseHabitsToday {
  state: QueryState;
  stale: boolean;
  items: HabitTodayItem[];
  /** Habits that count in the ring, and how many of them are done today. */
  done: number;
  due: number;
  /** What the app icon shows: build habits still to do today (abstain habits are not counted). */
  badge: number;
  tick(code: string): Promise<void>;
  /** Logs `value` as the day's total, not an increment. */
  setValue(code: string, value: number): Promise<void>;
  /** Adds `delta` to the latest value the person logged for the habit today, including logs that
   *  are still being queued, so two quick taps add up. */
  add(code: string, delta: number): Promise<void>;
  /** Takes back the newest unsent log of the habit. False: none is unsent (it was already sent). */
  release(code: string): Promise<boolean>;
  skip(code: string): Promise<void>;
  vacation(code: string): Promise<void>;
  /** Takes back a log that is still in the outbox. False: it was already sent. */
  undo(eventId: string): Promise<boolean>;
  /** The riyadh day the page shows. */
  day: Day;
  /** `GET /v1/today` as last loaded: the plan and the morning insight. */
  today: TodayOut | undefined;
  /** The last logged event, for the undo note. */
  last: LoggedEvent | null;
  clearLast(): void;
  reload(): void;
}

export function useHabitsToday(): UseHabitsToday {
  const [day, setDay] = useState<Day>(() => todayRiyadh());
  useEffect(() => onDayChange(setDay), []);

  const query = useQuery(todayQueryKey(day), () => loadTodayBundle(day));
  const [pending, setPendingState] = useState<OutboxEvent[]>([]);
  // Events the outbox sent that the loaded data may not include yet: kept over it until the reload.
  const [sent, setSent] = useState<OutboxEvent[]>([]);
  const [last, setLast] = useState<LoggedEvent | null>(null);

  const pendingRef = useRef<OutboxEvent[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const commit = useCallback((events: OutboxEvent[]) => {
    pendingRef.current = events;
    if (alive.current) setPendingState(events);
  }, []);
  const refreshPending = useCallback(async () => {
    commit(await listPending());
  }, [commit]);
  useEffect(() => {
    void refreshPending().catch(() => undefined);
  }, [refreshPending]);

  const reload = query.reload;
  const markSent = useCallback(
    (events: OutboxEvent[]) => {
      if (events.length === 0) return;
      setSent((s) => [...s, ...events]);
      reload();
    },
    [reload],
  );

  // While something waits in the outbox, notice when it is sent: reload what the server holds.
  useEffect(() => {
    if (pending.length === 0) return;
    const timer = setInterval(() => {
      void listPending()
        .then((now) => {
          const ids = new Set(now.map((e) => e.id));
          const gone = pendingRef.current.filter((e) => !ids.has(e.id));
          const waiting = now.filter((e) => !pendingRef.current.some((p) => p.id === e.id));
          commit([...pendingRef.current.filter((e) => ids.has(e.id)), ...waiting]);
          if (alive.current) markSent(gone);
        })
        .catch(() => undefined);
    }, pollTimeouts.pendingMs);
    return () => clearInterval(timer);
  }, [pending.length, commit, markSent]);

  // A fresh load includes what was sent: stop laying it over the data.
  const loaded = useRef(query.data);
  useEffect(() => {
    if (query.data !== loaded.current) {
      loaded.current = query.data;
      setSent([]);
    }
  }, [query.data]);

  const bundle = query.data?.day === day ? query.data : undefined;
  const state: QueryState = query.state === 'loading' && bundle !== undefined ? 'ready' : query.state;

  const items = useMemo(
    () => (bundle === undefined ? [] : buildItems(bundle, sent, pending, day)),
    [bundle, sent, pending, day],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const ringItems = items.filter((item) => countsInRing(item.habit));
  const due = ringItems.length;
  const done = ringItems.filter(isDoneToday).length;
  const badge = ringItems.filter((item) => polarityOf(item.habit) === 'build' && !isDoneToday(item)).length;

  // Logs are queued one after the other, so the events keep the order the person made them in, and
  // the value of a habit that is still being queued is kept here: a second quick tap adds to it
  // instead of to the value the screen had drawn when the first one landed.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const inflight = useRef(new Map<string, { count: number; value: number | null }>());

  const record = useCallback(
    (item: HabitTodayItem, input: LogHabitInput): Promise<void> => {
      const code = item.habit.code;
      const entry = inflight.current.get(code) ?? { count: 0, value: null };
      entry.count += 1;
      entry.value = input.status === 'done' && input.value !== undefined ? input.value : null;
      inflight.current.set(code, entry);
      const run = chain.current
        .then(async () => {
          const eventId = await logHabit(code, input);
          setLast({ eventId, code, title: item.habit.title_ar, status: input.status });
          await refreshPending();
        })
        .finally(() => {
          entry.count -= 1;
          if (entry.count === 0) inflight.current.delete(code);
        });
      chain.current = run.catch(() => undefined);
      return run;
    },
    [refreshPending],
  );
  const itemOf = (code: string): HabitTodayItem | undefined => itemsRef.current.find((i) => i.habit.code === code);
  /** The latest value of the habit today: one still being queued, else the one on screen. */
  const latestValue = (item: HabitTodayItem): number | null => {
    const queued = inflight.current.get(item.habit.code);
    return queued && queued.count > 0 ? queued.value : item.valueToday;
  };

  const tick = useCallback(
    async (code: string) => {
      const item = itemOf(code);
      const input = item && tickInput(item, latestValue(item));
      if (item && input) await record(item, input);
    },
    [record],
  );
  const setValue = useCallback(
    async (code: string, value: number) => {
      const item = itemOf(code);
      if (item) await record(item, { status: 'done', value });
    },
    [record],
  );
  const add = useCallback(
    async (code: string, delta: number) => {
      const item = itemOf(code);
      if (item) await record(item, { status: 'done', value: nextDayValue(latestValue(item), delta) });
    },
    [record],
  );
  const skip = useCallback(
    async (code: string) => {
      const item = itemOf(code);
      if (item) await record(item, { status: 'skip' });
    },
    [record],
  );
  const vacation = useCallback(
    async (code: string) => {
      const item = itemOf(code);
      if (item) await record(item, { status: 'vacation' });
    },
    [record],
  );

  const undo = useCallback(
    async (eventId: string): Promise<boolean> => {
      const event = pendingRef.current.find((e) => e.id === eventId);
      // Out of the overlay first, so the poll cannot mistake the discard for a send.
      commit(pendingRef.current.filter((e) => e.id !== eventId));
      const taken = await discard(eventId);
      if (taken) {
        setLast((l) => (l?.eventId === eventId ? null : l));
      } else if (event !== undefined) {
        markSent([event]);
      }
      return taken;
    },
    [commit, markSent],
  );

  const release = useCallback(
    async (code: string): Promise<boolean> => {
      const waiting = unsentFor(code, pendingRef.current, day);
      const newest = waiting[waiting.length - 1];
      return newest === undefined ? false : undo(newest.id);
    },
    [day, undo],
  );

  return {
    state,
    stale: query.stale,
    items,
    done,
    due,
    badge,
    tick,
    setValue,
    add,
    release,
    skip,
    vacation,
    undo,
    day,
    today: bundle?.today,
    last,
    clearLast: useCallback(() => setLast(null), []),
    reload,
  };
}
