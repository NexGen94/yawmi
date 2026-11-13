// The session of the focus page: what is running, and the events it makes. The state lives in `kv`
// (`focus_session`), the clock is read from the timestamps (`focus/timer.ts`), and every event goes
// through the outbox: «بدء» queues one `focus_started`, «حفظ الجلسة» one `focus_ended` (and one
// `habit_logged` when a duration habit is linked).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { components } from '../../api/schema';
import { endFocus, startFocus } from '../../data/events';
import { amount } from '../../habits/amount';
import type { UseHabitsToday } from '../../habits/useHabitsToday';
import { plantStage } from '../../focus/calc';
import {
  clearSession,
  elapsedMinutes,
  type FocusSessionState,
  loadEnding,
  loadSession,
  recordedMinutes,
  saveEnding,
  saveSession,
} from '../../focus/timer';
import { fmt } from '../../lib/format';

type FocusStartedPayload = components['schemas']['FocusStartedPayload'];
type FocusEndedPayload = components['schemas']['FocusEndedPayload'];

/** What «تمديد» adds to the planned time. */
export const EXTEND_MINUTES = 5;
/** The server takes references up to 64 characters on these events. */
const REF_MAX = 64;

export interface StartInput {
  minutes: number;
  goalRef?: string | null;
  habitCode?: string | null;
  planId?: string | null;
}

export interface Wrapup {
  rating: number | null;
  nextStep: string;
}

/** What was saved, for the note after a session. */
export interface SavedNote {
  minutes: number;
  planned: number;
  stage: 0 | 1 | 2 | 3 | 4;
  /** One sentence about the linked habit, when the session had one. */
  habit: string | null;
}

export interface UseFocusSession {
  /** The stored session has been read (before that the page does not know if one is running). */
  ready: boolean;
  session: FocusSessionState | null;
  /** The moment «إنهاء» was pressed while the wrap-up is open; null while running. */
  endedAt: Date | null;
  /** The clock the screen shows, read from the system each second and when the tab wakes. */
  now: Date;
  saved: SavedNote | null;
  start(input: StartInput): Promise<void>;
  extend(): Promise<void>;
  beginEnding(): Promise<void>;
  save(wrapup: Wrapup): Promise<void>;
  discard(): Promise<void>;
}

const fit = (ref: string | null | undefined): string | undefined =>
  ref && ref.length <= REF_MAX ? ref : undefined;

/** The linked habit: the day's value grows by the minutes (hours when the unit is an hour). */
async function logHabitMinutes(habits: UseHabitsToday, code: string, minutes: number): Promise<string> {
  const item = habits.allItems.find((i) => i.habit.code === code);
  if (item === undefined) return 'لم تُسجَّل الدقائق في العادة المرتبطة لأن بياناتها لم تُحمَّل';
  const { kind, unit, title_ar: title } = item.habit;
  if (kind !== 'duration' || (unit !== 'min' && unit !== 'hour')) return '';
  const delta = unit === 'hour' ? Math.round((minutes / 60) * 100) / 100 : minutes;
  const total = Math.round(((item.valueToday ?? 0) + delta) * 100) / 100;
  await habits.add(code, delta);
  return `سُجّلت الدقائق في عادة «${title}»: المجموع اليوم ${amount(total, unit)}`;
}

export function useFocusSession(habits: UseHabitsToday, onChanged: () => Promise<void>): UseFocusSession {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<FocusSessionState | null>(null);
  const [endedAt, setEndedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [saved, setSaved] = useState<SavedNote | null>(null);
  const busy = useRef(new Set<string>());
  const habitsRef = useRef(habits);
  habitsRef.current = habits;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  useEffect(() => {
    let alive = true;
    void Promise.all([loadSession(), loadEnding()])
      .then(([stored, ending]) => {
        if (!alive) return;
        setSession(stored);
        setEndedAt(stored !== null && ending !== null ? new Date(ending) : null);
      })
      .catch(() => undefined)
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // The clock: each reading is the system time, so a tab that slept or a machine that was offline
  // shows the right time on the next tick, on waking, or on coming back to the tab.
  // A layout effect: the clock starts with the first paint of the running view, not after it.
  const running = session !== null && endedAt === null;
  useLayoutEffect(() => {
    if (!running) return;
    const read = (): void => setNow(new Date());
    read();
    const timer = setInterval(read, 1000);
    document.addEventListener('visibilitychange', read);
    window.addEventListener('focus', read);
    window.addEventListener('pageshow', read);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
      window.removeEventListener('focus', read);
      window.removeEventListener('pageshow', read);
    };
  }, [running]);

  // One of each action at a time: a double tap on «بدء» or «حفظ الجلسة» makes one event.
  const once = useCallback(async (key: string, work: () => Promise<void>): Promise<void> => {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    try {
      await work();
    } finally {
      busy.current.delete(key);
    }
  }, []);

  const start = useCallback(
    (input: StartInput) =>
      once('start', async () => {
        if (session !== null) return;
        const goalRef = fit(input.goalRef);
        const habitCode = fit(input.habitCode);
        const state: FocusSessionState = {
          startedAt: new Date().toISOString(),
          plannedMinutes: input.minutes,
          ...(goalRef ? { goalRef } : {}),
          ...(habitCode ? { habitCode } : {}),
          ...(input.planId ? { planId: input.planId } : {}),
        };
        // The local state first: the running session is never lost to a failed send.
        await saveSession(state);
        setSession(state);
        setEndedAt(null);
        setNow(new Date());
        setSaved(null);
        // The generated type lists the fields with a server default as required (nulls); the server
        // takes them absent, and an absent one is simply not said.
        const payload = {
          planned_minutes: state.plannedMinutes,
          ...(goalRef ? { goal_ref: goalRef } : {}),
          ...(habitCode ? { habit_code: habitCode } : {}),
          ...(input.planId ? { plan_id: input.planId } : {}),
        };
        await startFocus(payload as FocusStartedPayload);
      }),
    [once, session],
  );

  const extend = useCallback(
    () =>
      once('extend', async () => {
        if (session === null) return;
        const next = { ...session, plannedMinutes: session.plannedMinutes + EXTEND_MINUTES };
        await saveSession(next);
        setSession(next);
        setNow(new Date());
      }),
    [once, session],
  );

  const beginEnding = useCallback(
    () =>
      once('ending', async () => {
        if (session === null || endedAt !== null) return;
        const at = new Date();
        await saveEnding(at.toISOString());
        setEndedAt(at);
      }),
    [once, session, endedAt],
  );

  const discard = useCallback(
    () =>
      once('discard', async () => {
        await clearSession();
        setSession(null);
        setEndedAt(null);
      }),
    [once],
  );

  const save = useCallback(
    (wrapup: Wrapup) =>
      once('save', async () => {
        if (session === null) return;
        // A clock set back before the start must not make an end before the start.
        const end = new Date(Math.max((endedAt ?? new Date()).getTime(), Date.parse(session.startedAt)));
        const elapsed = elapsedMinutes(session, end);
        const minutes = recordedMinutes(elapsed);
        const step = wrapup.nextStep.trim();
        const goalRef = fit(session.goalRef);
        const habitCode = fit(session.habitCode);
        const payload = {
          started_at: session.startedAt,
          ended_at: end.toISOString(),
          planned_minutes: session.plannedMinutes,
          actual_minutes: minutes,
          ...(goalRef ? { goal_ref: goalRef } : {}),
          ...(habitCode ? { habit_code: habitCode } : {}),
          ...(wrapup.rating !== null ? { focus_rating: wrapup.rating } : {}),
          ...(step !== '' ? { next_step: step } : {}),
        };
        await endFocus(payload as FocusEndedPayload);
        let habit: string | null = null;
        if (habitCode && minutes > 0) habit = (await logHabitMinutes(habitsRef.current, habitCode, minutes)) || null;
        await clearSession();
        setSession(null);
        setEndedAt(null);
        setSaved({ minutes, planned: session.plannedMinutes, stage: plantStage(elapsed, session.plannedMinutes), habit });
        await changedRef.current();
      }),
    [once, session, endedAt],
  );

  return { ready, session, endedAt, now, saved, start, extend, beginEnding, save, discard };
}

/** «31 دقيقة» for a note. */
export const minutesText = (n: number): string => fmt.count(n, 'minute');
