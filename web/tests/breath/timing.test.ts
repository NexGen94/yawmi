import { describe, expect, it } from 'vitest';

import { EXHALE_MAX_SECONDS, HOLD_MAX_SECONDS, HOLD_NOTE, PATTERNS, type PatternCode, RATES, SAFETY_TEXT } from '../../src/breath/patterns';
import { breathPayload, clampSeconds, cycle, hourRiyadh, normalizeRate, phaseAt, suggestPattern, testPayload } from '../../src/breath/timing';

const CODES = Object.keys(PATTERNS) as PatternCode[];

describe('the six styles (design 9.5, ruling 5)', () => {
  it('names the six styles with the labels, ratios and default rates of the design', () => {
    expect(PATTERNS).toEqual({
      calm: { label: 'تهدئة', inhale: 2, exhale: 3, rate: 6 },
      focus: { label: 'تركيز', inhale: 1, exhale: 1, rate: 6 },
      sleep: { label: 'تهيئة للنوم', inhale: 1, exhale: 2, rate: 5 },
      energize: { label: 'تنشيط الصباح', inhale: 1, exhale: 1, rate: 6.5 },
      unwind: { label: 'بعد العمل', inhale: 2, exhale: 3, rate: 5.5 },
      prepare: { label: 'قبل موقف مهم', inhale: 1, exhale: 2, rate: 6 },
    });
    expect(RATES).toEqual([5, 5.5, 6, 6.5]);
  });

  it('the default rate of every style is between 5 and 6.5', () => {
    for (const code of CODES) {
      expect(PATTERNS[code].rate).toBeGreaterThanOrEqual(5);
      expect(PATTERNS[code].rate).toBeLessThanOrEqual(6.5);
      expect(RATES).toContain(PATTERNS[code].rate);
    }
  });

  it('the caps and the safety texts are the ones of the design', () => {
    expect(EXHALE_MAX_SECONDS).toBe(60);
    expect(HOLD_MAX_SECONDS).toBe(30);
    expect(SAFETY_TEXT).toBe(
      'يُوقَف التمرين عند الدوار أو التنميل. لا يُمارَس أثناء القيادة. ومن لديه مرض في القلب أو الرئة، أو حمل، أو اضطراب هلع، يستشير طبيباً.',
    );
    expect(HOLD_NOTE).toBe('يمكن التوقف في أي لحظة');
  });
});

describe('cycle', () => {
  const secs = (code: PatternCode, rate: number): number[] => cycle(code, rate).map((p) => p.seconds);

  it('calm at 6 is inhale 4 and exhale 6', () => {
    expect(cycle('calm', 6)).toEqual([
      { phase: 'inhale', seconds: 4 },
      { phase: 'exhale', seconds: 6 },
    ]);
  });

  it('sleep at 5 is inhale 4 and exhale 8, focus at 6 is 5 and 5', () => {
    expect(secs('sleep', 5)).toEqual([4, 8]);
    expect(secs('focus', 6)).toEqual([5, 5]);
  });

  it('prepare at 6 is 3.333 and 6.667, to within 0.001', () => {
    const [inhale, exhale] = secs('prepare', 6);
    expect(Math.abs((inhale ?? 0) - 3.333)).toBeLessThan(0.001);
    expect(Math.abs((exhale ?? 0) - 6.667)).toBeLessThan(0.001);
  });

  it('every style at every rate has two phases only, inhale then exhale, and adds up to 60 / rate', () => {
    for (const code of CODES) {
      for (const rate of RATES) {
        const phases = cycle(code, rate);
        expect(
          phases.map((p) => p.phase),
          `${code} ${rate}`,
        ).toEqual(['inhale', 'exhale']);
        expect(phases.reduce((sum, p) => sum + p.seconds, 0)).toBeCloseTo(60 / rate, 9);
      }
    }
  });

  it('a rate outside the four throws a RangeError', () => {
    expect(() => cycle('calm', 4)).toThrow(RangeError);
    expect(() => cycle('calm', 8)).toThrow(RangeError);
    expect(() => cycle('calm', 6.25)).toThrow(RangeError);
    expect(() => cycle('calm', Number.NaN)).toThrow(RangeError);
  });
});

describe('suggestPattern (the hour in Riyadh)', () => {
  it('21 to 4 is sleep, 5 to 9 energize, 10 to 16 focus, the rest unwind', () => {
    expect(suggestPattern(22)).toBe('sleep');
    expect(suggestPattern(7)).toBe('energize');
    for (let h = 0; h < 24; h += 1) {
      const expected: PatternCode = h >= 21 || h <= 4 ? 'sleep' : h <= 9 ? 'energize' : h <= 16 ? 'focus' : 'unwind';
      expect(suggestPattern(h), `hour ${h}`).toBe(expected);
    }
    expect(suggestPattern(17)).toBe('unwind');
    expect(suggestPattern(20)).toBe('unwind');
  });

  it('the hour comes from Asia/Riyadh, not from the zone of the browser', () => {
    expect(hourRiyadh(Date.parse('2026-11-10T18:30:00Z'))).toBe(21);
    expect(hourRiyadh(Date.parse('2026-11-10T21:00:00Z'))).toBe(0);
    expect(hourRiyadh(Date.parse('2026-11-10T04:59:59Z'))).toBe(7);
  });
});

describe('phaseAt (from the elapsed seconds, never from a count of ticks)', () => {
  const calm = cycle('calm', 6); // 4 then 6

  it('reads the phase, what is left of it and how many breaths are done', () => {
    expect(phaseAt(calm, 0)).toMatchObject({ phase: 'inhale', phaseSeconds: 4, secondsLeft: 4, breaths: 0 });
    expect(phaseAt(calm, 1)).toMatchObject({ phase: 'inhale', secondsLeft: 3 });
    expect(phaseAt(calm, 4)).toMatchObject({ phase: 'exhale', phaseSeconds: 6, secondsLeft: 6 });
    expect(phaseAt(calm, 9.5)).toMatchObject({ phase: 'exhale', secondsLeft: 0.5 });
    expect(phaseAt(calm, 10)).toMatchObject({ phase: 'inhale', breaths: 1 });
    expect(phaseAt(calm, 125)).toMatchObject({ phase: 'exhale', breaths: 12, secondsLeft: 5 });
  });

  it('survives a long gap: the same result whatever the ticks in between', () => {
    // 20 minutes after the start, as if the tab slept the whole time.
    expect(phaseAt(calm, 1200)).toMatchObject({ phase: 'inhale', breaths: 120 });
    expect(phaseAt(calm, 1204.5)).toMatchObject({ phase: 'exhale', breaths: 120 });
  });

  it('the progress inside a phase goes from 0 to 1', () => {
    expect(phaseAt(calm, 0).progress).toBe(0);
    expect(phaseAt(calm, 2).progress).toBeCloseTo(0.5, 9);
    expect(phaseAt(calm, 7).progress).toBeCloseTo(0.5, 9);
  });
});

describe('the measured seconds are clamped before they are sent', () => {
  it('an overshoot of 30.4 s on the hold test is 30', () => {
    expect(clampSeconds(30_400, HOLD_MAX_SECONDS)).toBe(30);
  });

  it('whole seconds, never past the cap, never below zero', () => {
    expect(clampSeconds(17_600, EXHALE_MAX_SECONDS)).toBe(18);
    expect(clampSeconds(61_900, EXHALE_MAX_SECONDS)).toBe(60);
    expect(clampSeconds(-5, EXHALE_MAX_SECONDS)).toBe(0);
    expect(clampSeconds(Number.NaN, EXHALE_MAX_SECONDS)).toBe(0);
  });

  it('testPayload: the hold test is capped at 30 and the exhale test at 60', () => {
    const started = Date.parse('2026-11-10T09:00:00Z');
    const hold = testPayload('hold_test', started, started + 30_400);
    expect(hold).toMatchObject({ pattern: 'hold_test', duration_seconds: 30, completed: true, feeling: null, breaths_per_min: null });
    const exhale = testPayload('exhale_test', started, started + 120_000);
    expect(exhale.duration_seconds).toBe(60);
    expect(exhale.started_at).toBe('2026-11-10T09:00:00.000Z');
    expect(Date.parse(exhale.ended_at ?? '') - started).toBe(60_000);
  });
});

describe('the rate that is sent', () => {
  it('a named style never produces a rate outside 5 to 6.5, whatever was stored', () => {
    for (const code of CODES) {
      for (const stored of [0, 1, 4.9, 5, 5.5, 6, 6.5, 6.6, 7, 12, 60, Number.NaN]) {
        const rate = normalizeRate(code, stored);
        expect(rate, `${code} ${stored}`).toBeGreaterThanOrEqual(5);
        expect(rate, `${code} ${stored}`).toBeLessThanOrEqual(6.5);
        expect(RATES).toContain(rate);
      }
    }
  });

  it('a rate of the four is kept, anything else falls back to the default of the style', () => {
    expect(normalizeRate('sleep', 6.5)).toBe(6.5);
    expect(normalizeRate('sleep', 7)).toBe(5);
    expect(normalizeRate('energize', 3)).toBe(6.5);
  });

  it('breathPayload: every style at every rate is inside the limit, with the feeling or null', () => {
    const started = Date.parse('2026-11-10T09:00:00Z');
    for (const code of CODES) {
      for (const rate of RATES) {
        const payload = breathPayload({ pattern: code, rate, startedMs: started, elapsedMs: 300_000, plannedSeconds: 300, feeling: 'calmer' });
        expect(payload.breaths_per_min).toBe(rate);
        expect(payload).toMatchObject({ pattern: code, duration_seconds: 300, completed: true, feeling: 'calmer' });
      }
    }
    const skipped = breathPayload({ pattern: 'calm', rate: 6, startedMs: started, elapsedMs: 300_000, plannedSeconds: 300, feeling: null });
    expect(skipped.feeling).toBeNull();
  });

  it('a session that ends early is not completed, and one past its end is the planned length', () => {
    const started = Date.parse('2026-11-10T09:00:00Z');
    const early = breathPayload({ pattern: 'calm', rate: 6, startedMs: started, elapsedMs: 95_000, plannedSeconds: 300, feeling: null });
    expect(early).toMatchObject({ duration_seconds: 95, completed: false });
    const late = breathPayload({ pattern: 'calm', rate: 6, startedMs: started, elapsedMs: 3_600_000, plannedSeconds: 300, feeling: null });
    expect(late).toMatchObject({ duration_seconds: 300, completed: true });
    expect(Date.parse(late.ended_at ?? '') - started).toBe(300_000);
  });
});
