// Timing of a breathing session. Everything here is a function of timestamps: the elapsed time is
// `now - start`, never a count of ticks, so a tab that slept for a minute (its timers stopped) reads
// the same phase as one that ticked all along. The measured seconds are clamped to their cap here,
// before an event is queued, so an overshoot of a timer never reaches the server as a refusal.

import type { components } from '../api/schema';
import { EXHALE_MAX_SECONDS, HOLD_MAX_SECONDS, PATTERNS, type PatternCode, RATES, type TestCode } from './patterns';

export type BreathEndedPayload = components['schemas']['BreathEndedPayload'];
export type Feeling = NonNullable<BreathEndedPayload['feeling']>;

export type Phase = 'inhale' | 'exhale';

export interface CyclePhase {
  phase: Phase;
  seconds: number;
}

/** Riyadh is UTC+3 all year (no daylight saving), the same constant `lib/today.ts` uses. */
const RIYADH_OFFSET_HOURS = 3;

/** The hour (0 to 23) in Riyadh of an instant, whatever the zone of the browser. */
export function hourRiyadh(ms: number): number {
  return (new Date(ms).getUTCHours() + RIYADH_OFFSET_HOURS) % 24;
}

/** The style the hour asks for (design 9.5); the choice stays the person's. */
export function suggestPattern(hour: number): PatternCode {
  if (hour >= 21 || hour <= 4) return 'sleep';
  if (hour <= 9) return 'energize';
  if (hour <= 16) return 'focus';
  return 'unwind';
}

function isRate(rate: number): boolean {
  return (RATES as readonly number[]).includes(rate);
}

/** The two phases of one breath: 60 / rate seconds, split by the ratio of the style. Throws a
 *  `RangeError` for a rate outside 5, 5.5, 6 and 6.5. */
export function cycle(pattern: PatternCode, rate: number): CyclePhase[] {
  if (!isRate(rate)) throw new RangeError(`unsupported breathing rate: ${rate}`);
  const { inhale, exhale } = PATTERNS[pattern];
  const length = 60 / rate;
  const total = inhale + exhale;
  return [
    { phase: 'inhale', seconds: (length * inhale) / total },
    { phase: 'exhale', seconds: (length * exhale) / total },
  ];
}

/** A rate of the four is kept; anything else (a value stored by an older version, a corrupt one) is
 *  the default of the style, so a named style never goes outside 5 to 6.5. */
export function normalizeRate(pattern: PatternCode, rate: number): number {
  return isRate(rate) ? rate : PATTERNS[pattern].rate;
}

export interface PhasePosition {
  phase: Phase;
  /** How long this phase lasts, in seconds. */
  phaseSeconds: number;
  /** What is left of it. */
  secondsLeft: number;
  /** How far into it, 0 to 1. */
  progress: number;
  /** Whole breaths done before this one. */
  breaths: number;
}

/** Where a session is `elapsedSeconds` after its start. */
export function phaseAt(phases: readonly CyclePhase[], elapsedSeconds: number): PhasePosition {
  const length = phases.reduce((sum, p) => sum + p.seconds, 0);
  const elapsed = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
  const breaths = Math.floor(elapsed / length + 1e-9);
  const within = Math.max(0, elapsed - breaths * length);
  let start = 0;
  for (const p of phases) {
    // The small tolerance keeps 4.0000000001 from reading as the end of the first phase twice.
    if (within < start + p.seconds - 1e-9) {
      const into = within - start;
      return { phase: p.phase, phaseSeconds: p.seconds, secondsLeft: p.seconds - into, progress: into / p.seconds, breaths };
    }
    start += p.seconds;
  }
  const first = phases[0] as CyclePhase;
  return { phase: first.phase, phaseSeconds: first.seconds, secondsLeft: first.seconds, progress: 0, breaths: breaths + 1 };
}

/** Whole seconds of a measured span, from 0 to `capSeconds`: the cap is applied before anything is
 *  queued (the server refuses a longer one, and a refused event is set aside, not lost). */
export function clampSeconds(elapsedMs: number, capSeconds: number): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.min(capSeconds, Math.max(0, Math.round(elapsedMs / 1000)));
}

const TEST_CAPS: Readonly<Record<TestCode, number>> = { exhale_test: EXHALE_MAX_SECONDS, hold_test: HOLD_MAX_SECONDS };

export function testCap(kind: TestCode): number {
  return TEST_CAPS[kind];
}

/** The event of one test (exhale or hold): the span is capped at the cap of the test, and the end
 *  is the start plus that span, so the three fields agree. */
export function testPayload(kind: TestCode, startedMs: number, endedMs: number): BreathEndedPayload {
  const seconds = clampSeconds(endedMs - startedMs, TEST_CAPS[kind]);
  return {
    pattern: kind,
    started_at: new Date(startedMs).toISOString(),
    ended_at: new Date(startedMs + seconds * 1000).toISOString(),
    breaths_per_min: null,
    duration_seconds: seconds,
    completed: true,
    feeling: null,
  };
}

export interface SessionInput {
  pattern: PatternCode;
  rate: number;
  startedMs: number;
  /** Time from the start to the end, as measured by the clock. */
  elapsedMs: number;
  plannedSeconds: number;
  feeling: Feeling | null;
}

/** The event of one paced session. A session cannot last longer than it was planned (a tab that
 *  woke late is not a longer session), and one that ends before its plan is not completed. */
export function breathPayload(input: SessionInput): BreathEndedPayload {
  const seconds = clampSeconds(input.elapsedMs, input.plannedSeconds);
  return {
    pattern: input.pattern,
    started_at: new Date(input.startedMs).toISOString(),
    ended_at: new Date(input.startedMs + seconds * 1000).toISOString(),
    breaths_per_min: normalizeRate(input.pattern, input.rate),
    duration_seconds: seconds,
    completed: seconds >= input.plannedSeconds,
    feeling: input.feeling,
  };
}
