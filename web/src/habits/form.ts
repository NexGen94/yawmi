// Pure habit-form model: conversion to and from the API shapes, validation that mirrors
// the server HabitIn rules (task 10), and the system-habit field locks (spec 2.6).
// Dates are ISO strings handled with UTC arithmetic only; no device timezone is involved.

import { toOrdinal } from '../domain/days';
import { endDay } from '../domain/periods';
import type {
  HabitAnchor,
  HabitCreator,
  HabitDraft,
  HabitIn,
  HabitKind,
  HabitOut,
  HabitPeriod,
  HabitUnit,
  ReminderIn,
  ScheduleKind,
} from './types';

export const durationChips = [7, 30, 66, 100] as const;
export const maxReminders = 3;

/** A fixed chip, `custom` for a hand-entered end day, or null for an open-ended habit. */
export type DurationChoice = (typeof durationChips)[number] | 'custom' | null;

export interface HabitForm {
  title: string;
  goal_ref: string | null;
  outcome: string | null;
  kind: HabitKind;
  unit: HabitUnit;
  period: HabitPeriod;
  target_per_period: number;
  schedule_kind: ScheduleKind;
  weekday_mask: number | null;
  every_n: number | null;
  anchor_day: string | null;
  start_day: string | null;
  end_day: string | null;
  anchor: HabitAnchor;
  reminders: ReminderIn[];
  duration: DurationChoice;
  system: boolean;
  created_by: HabitCreator;
}

export type FormErrors = Partial<Record<keyof HabitForm, string>>;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The day ordinal of an ISO day (see `domain/days`), or null when it is not a calendar day. */
function parseDay(day: string): number | null {
  try {
    return toOrdinal(day);
  } catch {
    return null;
  }
}

/** `end = start + N - 1` (the first and last day both count): the domain rule, re-exported. */
export { endDay };

/** The most days a boolean habit can ask for inside one period (month: 28, always reachable). */
function periodDays(period: HabitPeriod): number {
  if (period === 'day') return 1;
  if (period === 'week') return 7;
  return 28;
}

function chipFor(start: string | null, end: string | null): DurationChoice {
  if (start === null || end === null) return null;
  const s = parseDay(start);
  const e = parseDay(end);
  if (s === null || e === null) return 'custom';
  const n = e - s + 1;
  return (durationChips as readonly number[]).includes(n) ? (n as DurationChoice) : 'custom';
}

/** The end day that will be sent: derived from a chip, as typed for custom, empty when open-ended. */
function effectiveEnd(f: HabitForm): string | null {
  if (f.duration === null) return null;
  if (f.duration === 'custom') return f.end_day;
  if (f.start_day === null || parseDay(f.start_day) === null) return null;
  return endDay(f.start_day, f.duration);
}

export function emptyForm(today: string): HabitForm {
  return {
    title: '',
    goal_ref: null,
    outcome: null,
    kind: 'boolean',
    unit: '',
    period: 'day',
    target_per_period: 1,
    schedule_kind: 'every_day',
    weekday_mask: null,
    every_n: null,
    anchor_day: null,
    start_day: today,
    end_day: null,
    anchor: 'free',
    reminders: [],
    duration: null,
    system: false,
    created_by: 'user',
  };
}

export function fromHabit(h: HabitOut): HabitForm {
  return {
    title: h.title,
    goal_ref: h.goal_ref,
    outcome: h.outcome,
    kind: h.kind,
    unit: h.unit ?? '',
    period: h.period,
    target_per_period: h.target_per_period,
    schedule_kind: h.schedule_kind,
    weekday_mask: h.weekday_mask,
    every_n: h.every_n,
    anchor_day: h.anchor_day,
    start_day: h.start_day,
    end_day: h.end_day,
    anchor: h.anchor ?? 'free',
    reminders: h.reminders.map((r) => ({ ...r })),
    duration: chipFor(h.start_day, h.end_day),
    system: h.system,
    created_by: h.created_by,
  };
}

/** A goal-to-habit suggestion opens the editor as a new, unsaved user habit. */
export function fromDraft(d: HabitDraft, today: string = d.start_day ?? ''): HabitForm {
  const base = emptyForm(today);
  const start = d.start_day ?? today;
  const end = d.end_day ?? null;
  return {
    ...base,
    title: d.title,
    goal_ref: d.goal_ref ?? null,
    outcome: d.outcome ?? null,
    kind: d.kind,
    unit: d.kind === 'boolean' ? '' : (d.unit ?? ''),
    period: d.period,
    target_per_period: d.target_per_period,
    schedule_kind: d.schedule_kind ?? 'every_day',
    weekday_mask: d.weekday_mask ?? null,
    every_n: d.every_n ?? null,
    anchor_day: d.anchor_day ?? null,
    start_day: start,
    end_day: end,
    anchor: d.anchor ?? 'free',
    reminders: (d.reminders ?? []).map((r) => ({ ...r })),
    duration: chipFor(start, end),
  };
}

export function validate(f: HabitForm): FormErrors {
  const errors: FormErrors = {};

  if (f.title.trim() === '') errors.title = 'العنوان مطلوب.';

  if (f.kind === 'boolean' && f.unit !== '') {
    errors.unit = 'العادة بنعم أو لا بلا وحدة.';
  } else if (f.kind === 'count' && f.unit !== '' && f.unit !== 'session') {
    errors.unit = 'وحدة العدد «جلسة» أو بلا وحدة.';
  } else if (f.kind === 'duration' && f.unit !== 'min' && f.unit !== 'hour') {
    errors.unit = 'عادة المدة تحتاج وحدة: دقيقة أو ساعة.';
  }

  if (!Number.isFinite(f.target_per_period) || f.target_per_period <= 0) {
    errors.target_per_period = 'الهدف في الفترة عدد موجب.';
  } else if (f.kind === 'boolean') {
    const max = periodDays(f.period);
    if (!Number.isInteger(f.target_per_period)) {
      errors.target_per_period = 'هدف عادة نعم أو لا عدد صحيح.';
    } else if (f.target_per_period > max) {
      errors.target_per_period =
        f.period === 'day'
          ? 'العادة اليومية بنعم أو لا هدفها 1.'
          : `هدف عادة نعم أو لا لا يتجاوز عدد أيام الفترة (${max}).`;
    }
  }

  if (f.period !== 'day' && f.schedule_kind !== 'every_day') {
    errors.schedule_kind = 'الجدول الخاص يقتصر على الفترة اليومية.';
  } else if (f.schedule_kind === 'weekdays') {
    if (f.weekday_mask === null || !Number.isInteger(f.weekday_mask) || f.weekday_mask < 1 || f.weekday_mask > 127) {
      errors.weekday_mask = 'الأيام المحددة تحتاج يوماً واحداً على الأقل.';
    }
  } else if (f.schedule_kind === 'every_n_days') {
    if (f.every_n === null || !Number.isInteger(f.every_n) || f.every_n < 2) {
      errors.every_n = 'التكرار «كل N أيام» يحتاج N من 2 فأكثر.';
    }
    if (f.anchor_day === null || parseDay(f.anchor_day) === null) {
      errors.anchor_day = 'التكرار «كل N أيام» يحتاج يوم مرساة.';
    }
  }

  if (f.start_day !== null && parseDay(f.start_day) === null) errors.start_day = 'تاريخ البداية غير صالح.';
  else if (f.start_day === null && typeof f.duration === 'number') {
    errors.start_day = 'المدة المحددة تحتاج تاريخ بداية.';
  }
  const end = effectiveEnd(f);
  if (f.duration === 'custom' && end !== null && parseDay(end) === null) {
    errors.end_day = 'تاريخ النهاية غير صالح.';
  } else if (f.duration === 'custom' && end === null) {
    errors.end_day = 'المدة المخصصة تحتاج تاريخ نهاية.';
  } else if (end !== null && f.start_day !== null && parseDay(end)! < (parseDay(f.start_day) ?? -Infinity)) {
    errors.end_day = 'النهاية لا تسبق البداية.';
  }

  if (f.reminders.length > maxReminders) {
    errors.reminders = `الحد الأقصى ${maxReminders} تذكيرات.`;
  } else if (
    f.reminders.some(
      (r) => !CLOCK.test(r.time) || !Number.isInteger(r.days_mask) || r.days_mask < 1 || r.days_mask > 127,
    )
  ) {
    errors.reminders = 'كل تذكير يحتاج وقتاً بصيغة HH:mm ويوماً واحداً على الأقل.';
  }

  return errors;
}

export function toHabitIn(f: HabitForm): HabitIn {
  const daily = f.period === 'day';
  const kind = daily ? f.schedule_kind : 'every_day';
  return {
    title: f.title.trim(),
    goal_ref: f.goal_ref,
    outcome: f.outcome,
    kind: f.kind,
    unit: f.kind === 'boolean' ? '' : f.unit,
    period: f.period,
    target_per_period: f.target_per_period,
    schedule_kind: kind,
    weekday_mask: kind === 'weekdays' ? f.weekday_mask : null,
    every_n: kind === 'every_n_days' ? f.every_n : null,
    anchor_day: kind === 'every_n_days' ? f.anchor_day : null,
    start_day: f.start_day,
    end_day: effectiveEnd(f),
    anchor: f.anchor,
    reminders: f.reminders.map((r) => ({ time: r.time, days_mask: r.days_mask })),
  };
}

/** System habits (seeded from GOAL-2031.md) change only their anchor and reminders. */
export function lockedFields(f: HabitForm): Set<keyof HabitForm> {
  if (!f.system) return new Set();
  const editable = new Set<keyof HabitForm>(['anchor', 'reminders']);
  const all = Object.keys(f) as (keyof HabitForm)[];
  return new Set(all.filter((k) => !editable.has(k)));
}
