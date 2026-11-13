// The choices of a session (style, rate, length, sound) and how they travel as `breath_prefs`
// (design 7.3: `pattern` one of the six, `minutes` 1 to 10, `rate` one of 5, 5.5, 6, 6.5, `sound`
// a boolean). What comes from the server is checked again here: a value outside the closed sets is
// replaced by a default, never used.

import type { components } from '../api/schema';
import { DEFAULT_MINUTES, isPatternCode, MAX_MINUTES, MIN_MINUTES, PATTERNS, type PatternCode } from './patterns';
import { hourRiyadh, normalizeRate, suggestPattern } from './timing';

export type BreathPrefs = components['schemas']['BreathPrefsIO'];

export interface Choice {
  pattern: PatternCode;
  rate: number;
  minutes: number;
  sound: boolean;
}

/** The style the hour asks for, at its own rate, five minutes, no sound. */
export function defaultChoice(nowMs: number): Choice {
  const pattern = suggestPattern(hourRiyadh(nowMs));
  return { pattern, rate: PATTERNS[pattern].rate, minutes: DEFAULT_MINUTES, sound: false };
}

function wholeMinutes(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, value));
}

/** The saved choices, each field checked; a missing or invalid one is the default's. */
export function choiceFromPrefs(prefs: BreathPrefs | null | undefined, fallback: Choice): Choice {
  if (prefs === null || prefs === undefined) return fallback;
  const pattern = isPatternCode(prefs.pattern) ? prefs.pattern : fallback.pattern;
  const rate = isPatternCode(prefs.pattern) ? normalizeRate(pattern, prefs.rate) : fallback.rate;
  return {
    pattern,
    rate,
    minutes: wholeMinutes(prefs.minutes, fallback.minutes),
    sound: typeof prefs.sound === 'boolean' ? prefs.sound : fallback.sound,
  };
}

export function prefsOf(choice: Choice): BreathPrefs {
  return { pattern: choice.pattern, minutes: choice.minutes, rate: choice.rate, sound: choice.sound };
}

export function sameChoice(a: Choice, b: Choice): boolean {
  return a.pattern === b.pattern && a.rate === b.rate && a.minutes === b.minutes && a.sound === b.sound;
}
