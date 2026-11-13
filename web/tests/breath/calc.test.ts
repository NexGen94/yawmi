import { describe, expect, it } from 'vitest';

import type { components } from '../../src/api/schema';
import { personalAverage, sessionDays, weekMinutes, weekSessionCount } from '../../src/breath/calc';

type Session = components['schemas']['BreathSessionOut'];

// Tuesday 2026-11-10: with the week starting on Sunday the week is 2026-11-08 to 2026-11-14.
const TODAY = '2026-11-10';

let n = 0;
function session(over: Partial<Session> = {}): Session {
  n += 1;
  const day = over.day ?? '2026-11-09';
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    day,
    started_at: `${day}T09:00:00Z`,
    ended_at: `${day}T09:10:00Z`,
    pattern: 'calm',
    breaths_per_min: 6,
    duration_seconds: 600,
    completed: true,
    feeling: null,
    ...over,
  };
}

describe('weekMinutes', () => {
  it('completed sessions of 1080 seconds this week are 18 minutes', () => {
    const sessions = [session({ day: '2026-11-08', duration_seconds: 600 }), session({ day: '2026-11-10', pattern: 'sleep', duration_seconds: 480 })];
    expect(weekMinutes(sessions, TODAY, 'sun')).toBe(18);
  });

  it('the hold test and the exhale test are not part of the total', () => {
    const sessions = [session({ duration_seconds: 1080 }), session({ pattern: 'hold_test', duration_seconds: 30 }), session({ pattern: 'exhale_test', duration_seconds: 40 })];
    expect(weekMinutes(sessions, TODAY, 'sun')).toBe(18);
  });

  it('only the six styles count, and a session that did not complete does not', () => {
    const sessions = [
      session({ duration_seconds: 120 }),
      session({ pattern: 'box', duration_seconds: 600 }),
      session({ completed: false, duration_seconds: 300 }),
      session({ duration_seconds: null }),
    ];
    expect(weekMinutes(sessions, TODAY, 'sun')).toBe(2);
  });

  it('the week is the one of today: the day before it and the day after it are out', () => {
    const sessions = [
      session({ day: '2026-11-07', duration_seconds: 600 }), // Saturday before
      session({ day: '2026-11-08', duration_seconds: 60 }), // Sunday, first day
      session({ day: '2026-11-14', duration_seconds: 60 }), // Saturday, last day
      session({ day: '2026-11-15', duration_seconds: 600 }), // next Sunday
    ];
    expect(weekMinutes(sessions, TODAY, 'sun')).toBe(2);
    // A week that starts on Monday is 2026-11-09 to 2026-11-15: the 8th is out, the 15th is in.
    expect(weekMinutes(sessions, TODAY, 'mon')).toBe(11);
  });

  it('no sessions is zero', () => {
    expect(weekMinutes([], TODAY, 'sun')).toBe(0);
  });
});

describe('sessionDays', () => {
  it('the days of the week with a counted session, in order and once each', () => {
    const sessions = [
      session({ day: '2026-11-10' }),
      session({ day: '2026-11-08' }),
      session({ day: '2026-11-08' }),
      session({ day: '2026-11-09', pattern: 'hold_test' }),
    ];
    expect(sessionDays(sessions, TODAY, 'sun')).toEqual(['2026-11-08', '2026-11-10']);
  });
});

describe('weekSessionCount', () => {
  it('counts the counted sessions of the week, not the tests and not other weeks', () => {
    const sessions = [session({ day: '2026-11-08' }), session({ day: '2026-11-08' }), session({ pattern: 'hold_test' }), session({ day: '2026-11-01' })];
    expect(weekSessionCount(sessions, TODAY, 'sun')).toBe(2);
  });
});

describe('personalAverage', () => {
  it('is the mean of the tests of that kind, or null without any', () => {
    const sessions = [
      session({ pattern: 'exhale_test', duration_seconds: 12 }),
      session({ pattern: 'exhale_test', duration_seconds: 18 }),
      session({ pattern: 'hold_test', duration_seconds: 21 }),
      session({ pattern: 'calm', duration_seconds: 600 }),
    ];
    expect(personalAverage(sessions, 'exhale_test')).toBe(15);
    expect(personalAverage(sessions, 'hold_test')).toBe(21);
    expect(personalAverage([], 'hold_test')).toBeNull();
    expect(personalAverage([session({ pattern: 'hold_test', duration_seconds: null })], 'hold_test')).toBeNull();
  });
});
