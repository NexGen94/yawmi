import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onDayChange, todayRiyadh } from '../../src/lib/today';

describe('todayRiyadh', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("todayRiyadh(new Date('2026-11-09T21:30:00Z')) === '2026-11-10'", () => {
    expect(todayRiyadh(new Date('2026-11-09T21:30:00Z'))).toBe('2026-11-10');
  });

  it('yields the exact same result regardless of browser TZ (e.g. America/New_York)', () => {
    process.env.TZ = 'America/New_York';
    expect(todayRiyadh(new Date('2026-11-09T21:30:00Z'))).toBe('2026-11-10');

    process.env.TZ = 'Asia/Tokyo';
    expect(todayRiyadh(new Date('2026-11-09T21:30:00Z'))).toBe('2026-11-10');
  });

  it('defaults to current time when now is omitted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T21:30:00Z'));
    expect(todayRiyadh()).toBe('2026-11-10');
    vi.useRealTimers();
  });
});

describe('onDayChange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls callback once when crossing midnight in Riyadh (2026-11-10T21:00:00Z)', () => {
    // 10 seconds before Riyadh midnight
    vi.setSystemTime(new Date('2026-11-10T20:59:50Z'));
    const calls: string[] = [];
    const unsubscribe = onDayChange((day) => {
      calls.push(day);
    });

    expect(calls).toHaveLength(0);

    // Advance past midnight (20 seconds forward: crosses 21:00:00Z)
    vi.advanceTimersByTime(20_000);

    expect(calls).toEqual(['2026-11-11']);

    // Advance another hour: no extra call
    vi.advanceTimersByTime(3_600_000);
    expect(calls).toEqual(['2026-11-11']);

    unsubscribe();
  });

  it('stops listening when unsubscribed', () => {
    vi.setSystemTime(new Date('2026-11-10T20:59:50Z'));
    const calls: string[] = [];
    const unsubscribe = onDayChange((day) => {
      calls.push(day);
    });

    unsubscribe();
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(0);
  });
});
