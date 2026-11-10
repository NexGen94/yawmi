import { describe, expect, it } from 'vitest';

import {
  durationChips,
  emptyForm,
  endDay,
  fromDraft,
  fromHabit,
  lockedFields,
  toHabitIn,
  validate,
  type HabitForm,
} from '../src/habits/form';
import type { HabitDraft, HabitOut } from '../src/habits/types';

const TODAY = '2026-11-09';

const form = (patch: Partial<HabitForm> = {}): HabitForm => ({ ...emptyForm(TODAY), title_ar: 'قراءة', ...patch });

const systemHabit: HabitOut = {
  code: 'meditation',
  title_ar: 'تأمّل 10 دقائق',
  goal_ref: null,
  outcome: 'O2',
  ac_ref: 'O2-AC1',
  kind: 'boolean',
  unit: '',
  period: 'week',
  target_per_period: 5,
  schedule_kind: 'every_day',
  weekday_mask: null,
  every_n: null,
  anchor_day: null,
  start_day: '2026-10-31',
  end_day: null,
  anchor: 'after_wake',
  reminders: [{ time: '06:30', days_mask: 127 }],
  system: true,
  created_by: 'seed',
  active: true,
};

describe('validate', () => {
  it('accepts the empty form once a title is given', () => {
    expect(validate(form())).toEqual({});
  });

  it('rejects a daily boolean habit with a target of 2', () => {
    expect(validate(form({ kind: 'boolean', period: 'day', target_per_period: 2 })).target_per_period).toBeTruthy();
  });

  it('allows a weekly boolean target up to 7 but not 8', () => {
    expect(validate(form({ period: 'week', target_per_period: 5 })).target_per_period).toBeUndefined();
    expect(validate(form({ period: 'week', target_per_period: 8 })).target_per_period).toBeTruthy();
  });

  it('requires a unit for duration habits', () => {
    expect(validate(form({ kind: 'duration', unit: '', target_per_period: 20 })).unit).toBeTruthy();
    expect(validate(form({ kind: 'duration', unit: 'min', target_per_period: 20 })).unit).toBeUndefined();
  });

  it('rejects a unit on boolean habits and a minute unit on count habits', () => {
    expect(validate(form({ kind: 'boolean', unit: 'min' })).unit).toBeTruthy();
    expect(validate(form({ kind: 'count', unit: 'min', target_per_period: 3 })).unit).toBeTruthy();
    expect(validate(form({ kind: 'count', unit: 'session', target_per_period: 3 })).unit).toBeUndefined();
  });

  it('rejects four reminders', () => {
    const r = { time: '07:00', days_mask: 127 };
    expect(validate(form({ reminders: [r, r, r] })).reminders).toBeUndefined();
    expect(validate(form({ reminders: [r, r, r, r] })).reminders).toBeTruthy();
  });

  it('rejects malformed reminder times and masks', () => {
    expect(validate(form({ reminders: [{ time: '25:00', days_mask: 127 }] })).reminders).toBeTruthy();
    expect(validate(form({ reminders: [{ time: '07:00', days_mask: 0 }] })).reminders).toBeTruthy();
  });

  it('requires a title', () => {
    expect(validate(form({ title_ar: '  ' })).title_ar).toBeTruthy();
  });

  it('restricts non-daily schedules to the daily period', () => {
    expect(validate(form({ period: 'week', schedule_kind: 'weekdays', weekday_mask: 5 })).schedule_kind).toBeTruthy();
    expect(validate(form({ period: 'day', schedule_kind: 'weekdays', weekday_mask: 0 })).weekday_mask).toBeTruthy();
    expect(
      validate(form({ period: 'day', schedule_kind: 'every_n_days', every_n: 3, anchor_day: null })).anchor_day,
    ).toBeTruthy();
  });

  it('rejects an end day before the start day', () => {
    expect(validate(form({ end_day: '2026-11-01', duration: 'custom' })).end_day).toBeTruthy();
  });

  it('uses Arabic messages without imperatives addressed to the user', () => {
    const errors = validate(form({ title_ar: '', kind: 'duration', unit: '', period: 'day', target_per_period: 0 }));
    expect(Object.keys(errors).length).toBeGreaterThan(0);
    for (const message of Object.values(errors)) {
      expect(message).toMatch(/[؀-ۿ]/);
      expect(message).not.toMatch(/(^|\s)(أدخل|اختر|اكتب|حدد|أضف)(\s|$)/);
    }
  });
});

describe('endDay and duration chips', () => {
  it('lists the fixed chips', () => {
    expect(durationChips).toEqual([7, 30, 66, 100]);
  });

  it('computes end = start + N - 1', () => {
    expect(endDay('2026-11-09', 30)).toBe('2026-12-08');
    expect(endDay('2026-11-09', 1)).toBe('2026-11-09');
    expect(endDay('2028-02-25', 7)).toBe('2028-03-02');
  });

  it('derives end_day from the chip and start day', () => {
    expect(toHabitIn(form({ start_day: TODAY, duration: 30 })).end_day).toBe('2026-12-08');
  });

  it('keeps a custom end day and clears it for an open-ended habit', () => {
    expect(toHabitIn(form({ duration: 'custom', end_day: '2027-01-31' })).end_day).toBe('2027-01-31');
    expect(toHabitIn(form({ duration: null, end_day: '2027-01-31' })).end_day).toBeNull();
  });
});

describe('system habits', () => {
  it('locks every field except anchor and reminders', () => {
    const f = fromHabit(systemHabit);
    const locked = lockedFields(f);
    expect(locked.has('anchor')).toBe(false);
    expect(locked.has('reminders')).toBe(false);
    for (const key of Object.keys(f) as (keyof HabitForm)[]) {
      if (key !== 'anchor' && key !== 'reminders') expect(locked.has(key), key).toBe(true);
    }
  });

  it('locks nothing on a user habit', () => {
    expect(lockedFields(form()).size).toBe(0);
    expect(lockedFields(fromHabit({ ...systemHabit, system: false, created_by: 'user' })).size).toBe(0);
  });
});

describe('conversions', () => {
  it('keeps goal_ref, outcome and the suggested target from a draft', () => {
    const draft: HabitDraft = {
      title_ar: 'مراجعة المحطة',
      goal_ref: 'abc123',
      outcome: 'O3',
      ac_ref: 'O3-AC2',
      kind: 'count',
      unit: 'session',
      period: 'week',
      target_per_period: 8,
      schedule_kind: 'every_day',
      weekday_mask: null,
      every_n: null,
      anchor_day: null,
      anchor: 'free',
      start_day: TODAY,
      end_day: null,
      reminders: [],
    };
    expect(toHabitIn(fromDraft(draft))).toMatchObject({
      title_ar: 'مراجعة المحطة',
      goal_ref: 'abc123',
      outcome: 'O3',
      ac_ref: 'O3-AC2',
      kind: 'count',
      unit: 'session',
      period: 'week',
      target_per_period: 8,
      start_day: TODAY,
    });
  });

  it('empties the unit for boolean habits', () => {
    expect(toHabitIn(form({ kind: 'boolean', unit: 'min', period: 'day', target_per_period: 1 })).unit).toBe('');
  });

  it('round-trips a stored habit', () => {
    const { code: _c, system: _s, created_by: _b, active: _a, ...expected } = systemHabit;
    expect(toHabitIn(fromHabit(systemHabit))).toEqual(expected);
  });

  it('recognises a chip when loading a duration habit', () => {
    const h: HabitOut = {
      ...systemHabit,
      system: false,
      created_by: 'user',
      start_day: '2026-11-09',
      end_day: '2026-12-08',
      kind: 'duration',
      unit: 'min',
      period: 'day',
      target_per_period: 20,
    };
    const f = fromHabit(h);
    expect(f.duration).toBe(30);
    expect(toHabitIn(f)).toMatchObject({ start_day: '2026-11-09', end_day: '2026-12-08' });
  });
});

describe('fix round 1', () => {
  it('caps a monthly boolean target at 28 regardless of the start day', () => {
    for (const start_day of [null, '2026-12-01', '2027-02-01']) {
      expect(validate(form({ period: 'month', start_day, target_per_period: 28 })).target_per_period).toBeUndefined();
      expect(validate(form({ period: 'month', start_day, target_per_period: 29 })).target_per_period).toBeTruthy();
    }
  });

  it('requires an integer boolean target but accepts fractional count and duration targets', () => {
    expect(validate(form({ period: 'week', target_per_period: 1.5 })).target_per_period).toBeTruthy();
    expect(validate(form({ kind: 'duration', unit: 'hour', period: 'day', target_per_period: 1.5 })).target_per_period).toBeUndefined();
    expect(validate(form({ kind: 'count', unit: 'session', period: 'day', target_per_period: 2.5 })).target_per_period).toBeUndefined();
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validate(form({ kind: 'count', unit: 'session', target_per_period: t })).target_per_period, String(t)).toBeTruthy();
    }
  });

  it('normalizes null unit and anchor from a seeded system habit', () => {
    const seeded = { ...systemHabit, unit: null, anchor: null } as unknown as HabitOut;
    const f = fromHabit(seeded);
    expect(f.unit).toBe('');
    expect(f.anchor).toBe('free');
    expect(validate(f)).toEqual({});
  });

  it('throws on a chip length below 1', () => {
    expect(() => endDay('2026-11-09', 0)).toThrow(RangeError);
    expect(() => endDay('2026-11-09', -3)).toThrow(RangeError);
  });

  it('reports a chip without a start day as a start_day error', () => {
    expect(validate(form({ start_day: null, duration: 30 })).start_day).toBeTruthy();
    expect(validate(form({ start_day: null, duration: null })).start_day).toBeUndefined();
  });

  it('keeps every validation message Arabic and free of imperatives', () => {
    const r = { time: '07:00', days_mask: 127 };
    const bad: HabitForm[] = [
      form({ title_ar: '', kind: 'duration', unit: '', period: 'day', target_per_period: 0 }),
      form({ kind: 'boolean', unit: 'min', period: 'day', target_per_period: 2 }),
      form({ kind: 'count', unit: 'min', target_per_period: Number.NaN }),
      form({ period: 'month', target_per_period: 40, schedule_kind: 'weekdays' }),
      form({ schedule_kind: 'weekdays', weekday_mask: 0 }),
      form({ schedule_kind: 'every_n_days', every_n: 1, anchor_day: null }),
      form({ start_day: 'x', duration: 'custom', end_day: null }),
      form({ start_day: null, duration: 7 }),
      form({ duration: 'custom', end_day: '2026-01-01' }),
      form({ duration: 'custom', end_day: 'bad' }),
      form({ reminders: [r, r, r, r] }),
      form({ reminders: [{ time: '99:99', days_mask: 0 }] }),
    ];
    const messages = bad.flatMap((f) => Object.values(validate(f)));
    expect(messages.length).toBeGreaterThan(12);
    for (const m of messages) {
      expect(m).toMatch(/[؀-ۿ]/);
      expect(m).not.toMatch(/(^|\s)(أدخل|اختر|اكتب|حدد|أضف|اضبط|ضع|استخدم)(\s|$)/);
      expect(m).not.toMatch(/(you|your)/i);
    }
  });
});

describe('server limits (HabitIn in openapi/openapi.json)', () => {
  it('caps the title at 200 characters', () => {
    expect(validate(form({ title_ar: 'ق'.repeat(200) })).title_ar).toBeUndefined();
    expect(validate(form({ title_ar: 'ق'.repeat(201) })).title_ar).toBeTruthy();
  });

  it('takes every_n from 2 to 365', () => {
    const every = (every_n: number) =>
      validate(form({ schedule_kind: 'every_n_days', every_n, anchor_day: TODAY })).every_n;
    expect(every(1)).toBeTruthy();
    expect(every(2)).toBeUndefined();
    expect(every(365)).toBeUndefined();
    expect(every(366)).toBeTruthy();
  });

  it('caps the target per period at 100000', () => {
    const target = (t: number) => validate(form({ kind: 'count', unit: 'session', target_per_period: t })).target_per_period;
    expect(target(100_000)).toBeUndefined();
    expect(target(100_001)).toBeTruthy();
  });

  it('sends ac_ref through unchanged, and null for a new habit', () => {
    expect(toHabitIn(form()).ac_ref).toBeNull();
    expect(toHabitIn(fromHabit({ ...systemHabit, system: false, created_by: 'user' })).ac_ref).toBe('O2-AC1');
  });

  it('opens a draft with its own start day', () => {
    const draft: HabitDraft = {
      ...systemHabit,
      goal_ref: 'g-1',
      start_day: '2026-12-01',
      end_day: '2026-12-30',
    };
    const f = fromDraft(draft);
    expect(f.start_day).toBe('2026-12-01');
    expect(f.duration).toBe(30);
    expect(f.system).toBe(false);
    expect(f.created_by).toBe('user');
  });
});
