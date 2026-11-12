import { describe, expect, it } from 'vitest';

import {
  durationChips,
  emptyForm,
  endDay,
  fromDraft,
  fromHabit,
  habitType,
  lockedFields,
  toHabitIn,
  toHabitPatch,
  validate,
  withDuration,
  withEnd,
  withStart,
  withType,
  type HabitForm,
} from '../src/habits/form';
import type { HabitDraft, HabitOut } from '../src/habits/types';

const TODAY = '2026-11-09';

// The editor always knows today: `validate(f, today)` (N-3). The tests written before that call it
// through this helper with the same day, so each keeps its meaning.
const check = (f: HabitForm, today: string = TODAY): ReturnType<typeof validate> => validate(f, today);

const form = (patch: Partial<HabitForm> = {}): HabitForm => ({ ...emptyForm(TODAY), title_ar: 'قراءة', ...patch });

const systemHabit: HabitOut = {
  code: 'meditation',
  title_ar: 'جلسة تأمّل 10 دقائق',
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
  polarity: 'build',
  identity_text: null,
};

describe('validate', () => {
  it('accepts the empty form once a title is given', () => {
    expect(check(form())).toEqual({});
  });

  it('rejects a daily boolean habit with a target of 2', () => {
    expect(check(form({ kind: 'boolean', period: 'day', target_per_period: 2 })).target_per_period).toBeTruthy();
  });

  it('allows a weekly boolean target up to 7 but not 8', () => {
    expect(check(form({ period: 'week', target_per_period: 5 })).target_per_period).toBeUndefined();
    expect(check(form({ period: 'week', target_per_period: 8 })).target_per_period).toBeTruthy();
  });

  it('requires a unit for duration habits', () => {
    expect(check(form({ kind: 'duration', unit: '', target_per_period: 20 })).unit).toBeTruthy();
    expect(check(form({ kind: 'duration', unit: 'min', target_per_period: 20 })).unit).toBeUndefined();
  });

  it('rejects a unit on boolean habits and a minute unit on count habits', () => {
    expect(check(form({ kind: 'boolean', unit: 'min' })).unit).toBeTruthy();
    expect(check(form({ kind: 'count', unit: 'min', target_per_period: 3 })).unit).toBeTruthy();
    expect(check(form({ kind: 'count', unit: 'session', target_per_period: 3 })).unit).toBeUndefined();
  });

  it('rejects four reminders', () => {
    const r = { time: '07:00', days_mask: 127 };
    expect(check(form({ reminders: [r, r, r] })).reminders).toBeUndefined();
    expect(check(form({ reminders: [r, r, r, r] })).reminders).toBeTruthy();
  });

  it('rejects malformed reminder times and masks', () => {
    expect(check(form({ reminders: [{ time: '25:00', days_mask: 127 }] })).reminders).toBeTruthy();
    expect(check(form({ reminders: [{ time: '07:00', days_mask: 0 }] })).reminders).toBeTruthy();
  });

  it('requires a title', () => {
    expect(check(form({ title_ar: '  ' })).title_ar).toBeTruthy();
  });

  it('restricts non-daily schedules to the daily period', () => {
    expect(check(form({ period: 'week', schedule_kind: 'weekdays', weekday_mask: 5 })).schedule_kind).toBeTruthy();
    expect(check(form({ period: 'day', schedule_kind: 'weekdays', weekday_mask: 0 })).weekday_mask).toBeTruthy();
    expect(
      check(form({ period: 'day', schedule_kind: 'every_n_days', every_n: 3, anchor_day: null })).anchor_day,
    ).toBeTruthy();
  });

  it('rejects an end day before the start day', () => {
    expect(check(form({ end_day: '2026-11-01', duration: 'custom' })).end_day).toBeTruthy();
  });

  it('uses Arabic messages without imperatives addressed to the user', () => {
    const errors = check(form({ title_ar: '', kind: 'duration', unit: '', period: 'day', target_per_period: 0 }));
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
  it('locks every field except anchor, reminders and identity_text (the server SYSTEM_EDITABLE)', () => {
    const f = fromHabit(systemHabit);
    const locked = lockedFields(f);
    expect(locked.has('anchor')).toBe(false);
    expect(locked.has('reminders')).toBe(false);
    for (const key of Object.keys(f) as (keyof HabitForm)[]) {
      if (key !== 'anchor' && key !== 'reminders' && key !== 'identity_text') expect(locked.has(key), key).toBe(true);
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
      polarity: 'build',
      identity_text: null,
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
      expect(check(form({ period: 'month', start_day, target_per_period: 28 })).target_per_period).toBeUndefined();
      expect(check(form({ period: 'month', start_day, target_per_period: 29 })).target_per_period).toBeTruthy();
    }
  });

  it('requires an integer boolean target but accepts fractional count and duration targets', () => {
    expect(check(form({ period: 'week', target_per_period: 1.5 })).target_per_period).toBeTruthy();
    expect(check(form({ kind: 'duration', unit: 'hour', period: 'day', target_per_period: 1.5 })).target_per_period).toBeUndefined();
    expect(check(form({ kind: 'count', unit: 'session', period: 'day', target_per_period: 2.5 })).target_per_period).toBeUndefined();
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(check(form({ kind: 'count', unit: 'session', target_per_period: t })).target_per_period, String(t)).toBeTruthy();
    }
  });

  it('takes unit and anchor as the server sends them (it never sends null: `to_api` fills them)', () => {
    const f = fromHabit({ ...systemHabit, kind: 'count', unit: 'session', anchor: 'before_sleep' });
    expect(f.unit).toBe('session');
    expect(f.anchor).toBe('before_sleep');
    expect(fromHabit(systemHabit).unit).toBe('');
    expect(check(fromHabit(systemHabit))).toEqual({});
  });

  it('throws on a chip length below 1', () => {
    expect(() => endDay('2026-11-09', 0)).toThrow(RangeError);
    expect(() => endDay('2026-11-09', -3)).toThrow(RangeError);
  });

  it('reports a chip without a start day as a start_day error', () => {
    expect(check(form({ start_day: null, duration: 30 })).start_day).toBeTruthy();
    expect(check(form({ start_day: null, duration: null })).start_day).toBeUndefined();
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
    const messages = bad.flatMap((f) => Object.values(check(f)));
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
    expect(check(form({ title_ar: 'ق'.repeat(200) })).title_ar).toBeUndefined();
    expect(check(form({ title_ar: 'ق'.repeat(201) })).title_ar).toBeTruthy();
  });

  it('takes every_n from 2 to 365', () => {
    const every = (every_n: number) =>
      check(form({ schedule_kind: 'every_n_days', every_n, anchor_day: TODAY })).every_n;
    expect(every(1)).toBeTruthy();
    expect(every(2)).toBeUndefined();
    expect(every(365)).toBeUndefined();
    expect(every(366)).toBeTruthy();
  });

  it('caps the target per period at 100000', () => {
    const target = (t: number) => check(form({ kind: 'count', unit: 'session', target_per_period: t })).target_per_period;
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

describe('server day range and end before today', () => {
  it.each([
    ['start_day', { start_day: '1999-12-31' }],
    ['start_day', { start_day: '2100-01-01' }],
    ['end_day', { duration: 'custom' as const, end_day: '2100-01-01' }],
    ['anchor_day', { schedule_kind: 'every_n_days' as const, every_n: 2, anchor_day: '1999-12-31' }],
  ])('refuses %s outside 2000-01-01..2099-12-31', (field, patch) => {
    expect(check(form(patch))[field as keyof HabitForm]).toBeTruthy();
  });

  it('accepts the first and last days of the range', () => {
    expect(check(form({ start_day: '2000-01-01', duration: 'custom', end_day: '2099-12-31' }))).toEqual({});
    expect(
      check(form({ schedule_kind: 'every_n_days', every_n: 2, anchor_day: '2099-12-31' })).anchor_day,
    ).toBeUndefined();
  });

  it('refuses a custom end before today when the start is left to the server (it becomes today)', () => {
    const f = form({ start_day: null, duration: 'custom', end_day: '2026-11-08' });
    expect(check(f, TODAY).end_day).toBeTruthy();
    expect(check({ ...f, end_day: TODAY }, TODAY).end_day).toBeUndefined();
  });

  it('keeps the new messages Arabic and free of imperatives', () => {
    const messages = [
      ...Object.values(check(form({ start_day: '1999-12-31' }))),
      ...Object.values(check(form({ start_day: null, duration: 'custom', end_day: '2026-11-08' }), TODAY)),
    ];
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m).toMatch(/[؀-ۿ]/);
      expect(m).not.toMatch(/(^|\s)(أدخل|اختر|اكتب|حدد|أضف|اضبط|ضع|استخدم)(\s|$)/);
    }
  });
});

describe('task 12: the period by date (A5)', () => {
  it('derives «إلى» from «من» and a chip: 2026-11-09 and 30 days end on 2026-12-08', () => {
    const f = withDuration(form({ start_day: '2026-11-09' }), 30);
    expect(f.duration).toBe(30);
    expect(f.end_day).toBe('2026-12-08');
  });

  it('moves «إلى» with «من» while a chip is chosen', () => {
    const f = withStart(withDuration(form({ start_day: '2026-11-09' }), 30), '2026-11-12');
    expect(f.end_day).toBe('2026-12-11');
    expect(f.duration).toBe(30);
  });

  it('editing «إلى» to 2026-12-20 makes the chip «مخصص» and keeps the typed day', () => {
    const f = withEnd(withDuration(form({ start_day: '2026-11-09' }), 30), '2026-12-20');
    expect(f.duration).toBe('custom');
    expect(f.end_day).toBe('2026-12-20');
    // «من» moving afterwards does not move a typed end.
    expect(withStart(f, '2026-11-12').end_day).toBe('2026-12-20');
  });

  it('a typed «إلى» that is exactly a chip length lights that chip', () => {
    expect(withEnd(form({ start_day: '2026-11-09' }), '2026-11-15').duration).toBe(7);
  });

  it('«مستمرة» empties «إلى», and a cleared «إلى» is the same', () => {
    const chosen = withDuration(form({ start_day: '2026-11-09' }), 30);
    expect(withDuration(chosen, null)).toMatchObject({ duration: null, end_day: null });
    expect(withEnd(chosen, '')).toMatchObject({ duration: null, end_day: null });
  });

  it('refuses «إلى» before «من» with «تاريخ النهاية قبل البداية»', () => {
    const f = withEnd(form({ start_day: '2026-11-09' }), '2026-11-01');
    expect(check(f).end_day).toContain('تاريخ النهاية قبل البداية');
  });

  it('accepts «إلى» equal to «من» (one day)', () => {
    expect(check(withEnd(form({ start_day: '2026-11-09' }), '2026-11-09')).end_day).toBeUndefined();
  });
});

describe('task 12: types, abstain and average', () => {
  it('abstain makes a daily yes/no habit with target 1 and locks those fields', () => {
    const f = withType(form({ kind: 'duration', unit: 'min', period: 'week', target_per_period: 120 }), 'abstain');
    expect(f).toMatchObject({ kind: 'boolean', unit: '', period: 'day', target_per_period: 1, polarity: 'abstain' });
    expect(habitType(f)).toBe('abstain');
    const locked = lockedFields(f);
    for (const key of ['kind', 'period', 'target_per_period'] as const) expect(locked.has(key), key).toBe(true);
    expect(locked.has('title_ar')).toBe(false);
    expect(check(f)).toEqual({});
    expect(toHabitIn(f)).toMatchObject({ polarity: 'abstain', kind: 'boolean', period: 'day', target_per_period: 1 });
  });

  it('leaving abstain frees the fields and makes a build habit again', () => {
    const f = withType(withType(form(), 'abstain'), 'count');
    expect(f.polarity).toBe('build');
    expect(lockedFields(f).has('kind')).toBe(false);
  });

  it('average is a daily count whose measure is «average»', () => {
    const f = withType(form({ kind: 'duration', unit: 'min', period: 'week', target_per_period: 120 }), 'average');
    expect(f).toMatchObject({ kind: 'count', period: 'day', measure: 'average', polarity: 'build' });
    expect(habitType(f)).toBe('average');
    expect(lockedFields(f).has('period')).toBe(true);
  });

  it('the four other types set the kind and the unit', () => {
    expect(withType(form({ kind: 'duration', unit: 'min' }), 'yesno')).toMatchObject({ kind: 'boolean', unit: '' });
    expect(withType(form(), 'count')).toMatchObject({ kind: 'count', unit: '' });
    expect(withType(form(), 'duration')).toMatchObject({ kind: 'duration', unit: 'min' });
    expect(withType(form({ kind: 'duration', unit: 'hour' }), 'duration').unit).toBe('hour');
  });

  it('a yes/no weekly target stays inside the days of the period when the type changes to it', () => {
    const f = withType(form({ kind: 'duration', unit: 'min', period: 'week', target_per_period: 285 }), 'yesno');
    expect(check(f).target_per_period).toBeUndefined();
  });
});

describe('task 12: the identity sentence', () => {
  it('takes 300 characters and refuses 301', () => {
    expect(check(form({ identity_text: 'ق'.repeat(300) })).identity_text).toBeUndefined();
    expect(check(form({ identity_text: 'ق'.repeat(301) })).identity_text).toBeTruthy();
  });

  it('sends a blank sentence as null and a written one trimmed', () => {
    expect(toHabitIn(form({ identity_text: '   ' })).identity_text).toBeNull();
    expect(toHabitIn(form({ identity_text: ' أنا قارئ ' })).identity_text).toBe('أنا قارئ');
  });

  it('is editable on a system habit', () => {
    expect(lockedFields(fromHabit(systemHabit)).has('identity_text')).toBe(false);
  });
});

describe('task 12: toHabitPatch (B17)', () => {
  const user: HabitOut = { ...systemHabit, system: false, created_by: 'user' };

  it('is empty when nothing changed', () => {
    expect(toHabitPatch(user, fromHabit(user))).toEqual({});
  });

  it('carries the title alone when only the title changed', () => {
    expect(toHabitPatch(user, { ...fromHabit(user), title_ar: 'تأمّل صباحي' })).toEqual({ title_ar: 'تأمّل صباحي' });
  });

  it('carries every changed field, a cleared end day as null, and the reminders whole', () => {
    const original: HabitOut = { ...user, start_day: '2026-11-09', end_day: '2026-12-08' };
    const f = withDuration(fromHabit(original), null);
    const patch = toHabitPatch(original, {
      ...f,
      identity_text: 'أنا شخص هادئ',
      reminders: [{ time: '07:00', days_mask: 127 }],
    });
    expect(patch).toEqual({
      end_day: null,
      identity_text: 'أنا شخص هادئ',
      reminders: [{ time: '07:00', days_mask: 127 }],
    });
  });

  it('never sends a start day that is empty', () => {
    expect(toHabitPatch(user, { ...fromHabit(user), start_day: null })).toEqual({});
  });

  it('a system habit changes its anchor and reminders alone', () => {
    const patch = toHabitPatch(systemHabit, { ...fromHabit(systemHabit), anchor: 'free' });
    expect(patch).toEqual({ anchor: 'free' });
  });
});

describe('task 12: validate needs today (N-3)', () => {
  it('is a type error to call it without today', () => {
    // @ts-expect-error `today` is required
    expect(validate(form())).toEqual({});
  });
});
