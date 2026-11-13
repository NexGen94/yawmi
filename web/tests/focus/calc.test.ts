import { describe, expect, it } from 'vitest';

import type { components } from '../../src/api/schema';
import {
  applyPendingFocus,
  FOCUS_TEMPLATES,
  focusScore,
  focusTarget,
  hourBins,
  minutesOn,
  plantStage,
  topHour,
} from '../../src/focus/calc';

type Session = components['schemas']['FocusSessionOut'];

function session(startedAt: string, endedAt: string | null, over: Partial<Session> = {}): Session {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    day: '2026-11-10',
    started_at: startedAt,
    ended_at: endedAt,
    planned_minutes: 25,
    actual_minutes: 25,
    goal_ref: null,
    habit_code: null,
    focus_rating: null,
    next_step: null,
    ...over,
  };
}

describe('plantStage (design 9.5)', () => {
  it('12 of 25 minutes is stage 2', () => {
    expect(plantStage(12, 25)).toBe(2);
  });

  it('runs from 0 to 4 and never past it', () => {
    expect(plantStage(0, 25)).toBe(0);
    expect(plantStage(4.9, 25)).toBe(0);
    expect(plantStage(5, 25)).toBe(1);
    expect(plantStage(24.9, 25)).toBe(4);
    expect(plantStage(25, 25)).toBe(4);
    expect(plantStage(31, 25)).toBe(4);
  });

  it('a missing plan or a negative time stays at stage 0', () => {
    expect(plantStage(10, 0)).toBe(0);
    expect(plantStage(-3, 25)).toBe(0);
    expect(plantStage(Number.NaN, 25)).toBe(0);
  });
});

describe('focusScore (design 9.5)', () => {
  it('45 of 90 is 50', () => {
    expect(focusScore(45, 90)).toBe(50);
  });

  it('has no score without a target', () => {
    expect(focusScore(45, null)).toBeNull();
    expect(focusScore(45, 0)).toBeNull();
  });

  it('is capped at 100 and rounds', () => {
    expect(focusScore(200, 90)).toBe(100);
    expect(focusScore(0, 90)).toBe(0);
    expect(focusScore(1, 3)).toBe(33);
  });
});

describe('focusTarget: the morning plan first, then the setting, else none', () => {
  it('prefers the planned minutes of the morning', () => {
    expect(focusTarget(90, 60)).toBe(90);
  });
  it('falls back to the daily target setting', () => {
    expect(focusTarget(null, 60)).toBe(60);
    expect(focusTarget(undefined, 60)).toBe(60);
    expect(focusTarget(0, 60)).toBe(60);
  });
  it('is null when neither exists', () => {
    expect(focusTarget(null, null)).toBeNull();
    expect(focusTarget(undefined, undefined)).toBeNull();
  });
});

describe('hourBins (design 9.5): minutes per Riyadh hour', () => {
  it('a session from 09:40 to 10:30 gives 20 for hour 9 and 30 for hour 10', () => {
    const bins = hourBins([session('2026-11-10T06:40:00Z', '2026-11-10T07:30:00Z')]);
    expect(bins).toHaveLength(24);
    expect(bins[9]).toBe(20);
    expect(bins[10]).toBe(30);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(50);
  });

  it('reads the Riyadh hour, not the UTC hour', () => {
    const bins = hourBins([session('2026-11-10T21:30:00Z', '2026-11-10T21:50:00Z')]);
    expect(bins[0]).toBe(20); // 00:30 to 00:50 the next day in Riyadh
    expect(bins[21]).toBe(0);
  });

  it('a session over midnight splits across hour 23 and hour 0', () => {
    const bins = hourBins([session('2026-11-10T20:50:00Z', '2026-11-10T21:10:00Z')]);
    expect(bins[23]).toBe(10);
    expect(bins[0]).toBe(10);
  });

  it('adds sessions up and skips one that has not ended', () => {
    const bins = hourBins([
      session('2026-11-10T06:00:00Z', '2026-11-10T06:30:00Z'),
      session('2026-11-11T06:00:00Z', '2026-11-11T06:15:00Z'),
      session('2026-11-12T06:00:00Z', null),
    ]);
    expect(bins[9]).toBe(45);
  });

  it('no sessions gives 24 zeros', () => {
    expect(hourBins([])).toEqual(Array.from({ length: 24 }, () => 0));
  });
});

describe('topHour', () => {
  it('names the hour with the most minutes, the earliest on a tie', () => {
    const bins = Array.from({ length: 24 }, () => 0);
    bins[14] = 40;
    bins[9] = 40;
    expect(topHour(bins)).toEqual({ hour: 9, minutes: 40 });
  });
  it('is null when nothing was recorded', () => {
    expect(topHour(Array.from({ length: 24 }, () => 0))).toBeNull();
  });
});

describe('minutesOn', () => {
  it('sums the actual minutes of the sessions of one day', () => {
    const sessions = [
      session('2026-11-10T06:00:00Z', '2026-11-10T06:25:00Z', { actual_minutes: 25 }),
      session('2026-11-10T08:00:00Z', '2026-11-10T08:20:00Z', { actual_minutes: 20 }),
      session('2026-11-09T08:00:00Z', '2026-11-09T09:00:00Z', { day: '2026-11-09', actual_minutes: 60 }),
    ];
    expect(minutesOn(sessions, '2026-11-10')).toBe(45);
  });
});

describe('applyPendingFocus: an ended session still in the outbox counts at once', () => {
  const event = (payload: Record<string, unknown>, occurredAt = '2026-11-10T07:30:00Z') => ({
    id: '00000000-0000-7000-8000-0000000000aa',
    type: 'focus_ended' as const,
    payload,
    occurred_at: occurredAt,
    tz: 'Asia/Riyadh',
  });

  it('adds a session built the way the server builds it', () => {
    const out = applyPendingFocus(
      [],
      [event({ planned_minutes: 25, actual_minutes: 31, started_at: '2026-11-10T06:59:00Z', ended_at: '2026-11-10T07:30:00Z' })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ day: '2026-11-10', actual_minutes: 31, planned_minutes: 25 });
  });

  it('derives the start from the end and the length when the payload has no start', () => {
    const [s] = applyPendingFocus([], [event({ actual_minutes: 30 })]);
    expect(s?.started_at).toBe('2026-11-10T07:00:00.000Z');
  });

  it('does not count an event the server already holds', () => {
    const held = session('2026-11-10T07:00:00Z', '2026-11-10T07:30:00Z', { id: '00000000-0000-7000-8000-0000000000aa' });
    expect(applyPendingFocus([held], [event({ actual_minutes: 30 })])).toHaveLength(1);
  });

  it('ignores other event types', () => {
    const other = { ...event({}), type: 'habit_logged' as const };
    expect(applyPendingFocus([], [other])).toEqual([]);
  });
});

describe('FOCUS_TEMPLATES', () => {
  it('are the two ready plans of the brief', () => {
    expect(FOCUS_TEMPLATES).toEqual([
      { title: 'جلسة صباحية', minutes: 25 },
      { title: 'عمل عميق', minutes: 90 },
    ]);
  });
});
