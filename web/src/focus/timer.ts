// The running session. Its state is a start time and a planned length, kept in `kv` under
// `focus_session`; what the screen shows is computed from the clock each time it is drawn, never
// counted by ticks. A reload, a sleeping tab or hours offline therefore change nothing: the next
// reading is exact. (Design 9.5: the counter keeps going up after the planned time.)

import { kvDelete, kvGet, kvSet } from '../data/cache';
import { fmt } from '../lib/format';

export interface FocusSessionState {
  /** ISO instant the session began. */
  startedAt: string;
  plannedMinutes: number;
  goalRef?: string;
  habitCode?: string;
  planId?: string;
}

const SESSION_KEY = 'focus_session';
/** While the wrap-up (rating and next step) is open the session is frozen at the moment «إنهاء» was
 *  pressed; the moment lives here so a reload does not let the time run on. */
const ENDING_KEY = 'focus_ending';

const MS_PER_MINUTE = 60_000;

const startMs = (s: FocusSessionState): number => Date.parse(s.startedAt);

/** Seconds since the start, never negative (a clock set back reads as 0). */
export function elapsedSeconds(s: FocusSessionState, now: Date): number {
  const ms = now.getTime() - startMs(s);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

/** Minutes since the start, with the seconds as a fraction, never negative. */
export function elapsedMinutes(s: FocusSessionState, now: Date): number {
  const ms = now.getTime() - startMs(s);
  return Number.isFinite(ms) ? Math.max(0, ms / MS_PER_MINUTE) : 0;
}

/** `running` until the planned time, `overflow` from it on. */
export function phase(s: FocusSessionState, now: Date): 'running' | 'overflow' {
  return elapsedMinutes(s, now) >= s.plannedMinutes ? 'overflow' : 'running';
}

/** What is recorded for a session: whole minutes, to the nearest. */
export function recordedMinutes(elapsed: number): number {
  return Math.max(0, Math.round(elapsed));
}

/** «25:00»: minutes and seconds, two digits each, in the digits of the setting. */
export function clockText(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const two = { minimumIntegerDigits: 2 };
  return `${fmt.num(Math.floor(total / 60), two)}:${fmt.num(total % 60, two)}`;
}

function isState(value: unknown): value is FocusSessionState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const optional = (key: string): boolean => v[key] === undefined || typeof v[key] === 'string';
  return (
    typeof v.startedAt === 'string' &&
    Number.isFinite(Date.parse(v.startedAt)) &&
    typeof v.plannedMinutes === 'number' &&
    v.plannedMinutes > 0 &&
    optional('goalRef') &&
    optional('habitCode') &&
    optional('planId')
  );
}

/** The session in progress, or null (also for a stored value that is not a session). */
export async function loadSession(): Promise<FocusSessionState | null> {
  const value = await kvGet<unknown>(SESSION_KEY);
  return isState(value) ? value : null;
}

export async function saveSession(s: FocusSessionState): Promise<void> {
  await kvSet(SESSION_KEY, s);
}

/** Ends the stored session together with its frozen end moment. */
export async function clearSession(): Promise<void> {
  await kvDelete(SESSION_KEY);
  await kvDelete(ENDING_KEY);
}

/** The ISO moment «إنهاء» was pressed, while the wrap-up is open. */
export async function loadEnding(): Promise<string | null> {
  const value = await kvGet<unknown>(ENDING_KEY);
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

export async function saveEnding(endedAt: string): Promise<void> {
  await kvSet(ENDING_KEY, endedAt);
}
