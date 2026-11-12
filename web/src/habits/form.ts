// Pure habit-form model: conversion to and from the API shapes, validation that mirrors
// the server HabitIn rules (task 10, and the limits in openapi/openapi.json), and the system-habit
// field locks (spec 2.6). Field names are the server's (`title_ar`, `ac_ref`, ...).
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
  HabitPatch,
  HabitPeriod,
  HabitPolarity,
  HabitUnit,
  ReminderIn,
  ScheduleKind,
} from './types';

export const durationChips = [7, 30, 66, 100] as const;
export const maxReminders = 3;

/** A fixed chip, `custom` for a hand-entered end day, or null for an open-ended habit. */
export type DurationChoice = (typeof durationChips)[number] | 'custom' | null;

/** What the indicator of the habit measures: the period target, or the average of the last 7 days
 *  («متوسط», design 13.1 ruling 11: a daily count with an `avg_7d` indicator, not a fourth kind). */
export type HabitMeasure = 'target' | 'average';

/** The five types the editor offers; each is a setting of `kind`, `polarity` and `measure`. */
export type HabitType = 'yesno' | 'count' | 'duration' | 'average' | 'abstain';

export interface HabitForm {
  title_ar: string;
  goal_ref: string | null;
  outcome: string | null;
  /** The acceptance criterion the habit serves, carried over from a draft or a stored habit. */
  ac_ref: string | null;
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
  polarity: HabitPolarity;
  /** The identity sentence as typed; blank is sent as null. */
  identity_text: string;
  measure: HabitMeasure;
}

export type FormErrors = Partial<Record<keyof HabitForm, string>>;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
// Server limits (HabitIn in openapi/openapi.json).
const MAX_TITLE = 200;
const MAX_IDENTITY = 300;
const MAX_TARGET = 100_000;
const MIN_EVERY_N = 2;
const MAX_EVERY_N = 365;
// Stored days (start, end, anchor) lie in this range on the server (`FIRST_DAY`/`LAST_DAY`).
const FIRST_DAY = '2000-01-01';
const LAST_DAY = '2099-12-31';
const DAY_OUT_OF_RANGE = `اليوم خارج النطاق المقبول (${FIRST_DAY} إلى ${LAST_DAY}).`;

/** The day ordinal of an ISO day (see `domain/days`), or null when it is not a calendar day. */
function parseDay(day: string): number | null {
  try {
    return toOrdinal(day);
  } catch {
    return null;
  }
}

/** Whether a calendar day (already parsed) lies in the server's range; ISO days compare as strings. */
const inRange = (day: string): boolean => day >= FIRST_DAY && day <= LAST_DAY;

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
    title_ar: '',
    goal_ref: null,
    outcome: null,
    ac_ref: null,
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
    polarity: 'build',
    identity_text: '',
    measure: 'target',
  };
}

export function fromHabit(h: HabitOut): HabitForm {
  return {
    title_ar: h.title_ar,
    goal_ref: h.goal_ref,
    outcome: h.outcome,
    ac_ref: h.ac_ref,
    kind: h.kind,
    unit: h.unit,
    period: h.period,
    target_per_period: h.target_per_period,
    schedule_kind: h.schedule_kind,
    weekday_mask: h.weekday_mask,
    every_n: h.every_n,
    anchor_day: h.anchor_day,
    start_day: h.start_day,
    end_day: h.end_day,
    anchor: h.anchor,
    reminders: h.reminders.map((r) => ({ ...r })),
    duration: chipFor(h.start_day, h.end_day),
    system: h.system,
    created_by: h.created_by,
    polarity: h.polarity,
    identity_text: h.identity_text ?? '',
    measure: 'target',
  };
}

/**
 * A goal-to-habit suggestion opens the editor as a new, unsaved user habit. The server fills every
 * field of a draft, its start day included (today in Riyadh unless the goal says otherwise).
 */
export function fromDraft(d: HabitDraft): HabitForm {
  return {
    ...emptyForm(d.start_day),
    title_ar: d.title_ar,
    goal_ref: d.goal_ref,
    outcome: d.outcome,
    ac_ref: d.ac_ref,
    kind: d.kind,
    unit: d.kind === 'boolean' ? '' : d.unit,
    period: d.period,
    target_per_period: d.target_per_period,
    schedule_kind: d.schedule_kind,
    weekday_mask: d.weekday_mask,
    every_n: d.every_n,
    anchor_day: d.anchor_day,
    start_day: d.start_day,
    end_day: d.end_day,
    anchor: d.anchor,
    reminders: d.reminders.map((r) => ({ ...r })),
    duration: chipFor(d.start_day, d.end_day),
    polarity: d.polarity,
    identity_text: d.identity_text ?? '',
  };
}

/**
 * Field errors, in Arabic, for what the server would refuse. `today` (the Riyadh day) is required:
 * with `start_day` left empty the server starts the habit today, so a custom end before today is
 * refused, and a caller that forgot the day would silently skip that rule.
 */
export function validate(f: HabitForm, today: string): FormErrors {
  const errors: FormErrors = {};
  const set = (field: keyof HabitForm, message: string | undefined): void => {
    if (message !== undefined) errors[field] = message;
  };
  set('title_ar', titleError(f.title_ar));
  set('unit', unitError(f));
  set('target_per_period', targetError(f));
  scheduleErrors(f, errors);
  dayErrors(f, today, errors);
  set('reminders', remindersError(f.reminders));
  set('identity_text', identityError(f.identity_text));
  set('kind', abstainError(f));
  return errors;
}

function titleError(title: string): string | undefined {
  const trimmed = title.trim();
  if (trimmed === '') return 'العنوان مطلوب.';
  // The server counts characters (code points), as the spread does; `length` would count UTF-16 units.
  if ([...trimmed].length > MAX_TITLE) return `العنوان لا يتجاوز ${MAX_TITLE} حرف.`;
  return undefined;
}

function identityError(text: string): string | undefined {
  return [...text.trim()].length > MAX_IDENTITY ? `جملة الهوية لا تتجاوز ${MAX_IDENTITY} حرف.` : undefined;
}

function abstainError(f: HabitForm): string | undefined {
  if (f.polarity !== 'abstain') return undefined;
  const fits = f.kind === 'boolean' && f.period === 'day' && f.target_per_period === 1;
  return fits ? undefined : 'عادة الامتناع بنعم أو لا يومية وهدفها 1.';
}

function unitError(f: HabitForm): string | undefined {
  if (f.kind === 'boolean' && f.unit !== '') return 'العادة بنعم أو لا بلا وحدة.';
  if (f.kind === 'count' && f.unit !== '' && f.unit !== 'session') return 'وحدة العدد «جلسة» أو بلا وحدة.';
  if (f.kind === 'duration' && f.unit !== 'min' && f.unit !== 'hour') return 'عادة المدة تحتاج وحدة: دقيقة أو ساعة.';
  return undefined;
}

function targetError(f: HabitForm): string | undefined {
  const target = f.target_per_period;
  if (!Number.isFinite(target) || target <= 0) return 'الهدف في الفترة عدد موجب.';
  if (target > MAX_TARGET) return `الهدف في الفترة لا يتجاوز ${MAX_TARGET}.`;
  if (f.kind !== 'boolean') return undefined;
  const max = periodDays(f.period);
  if (!Number.isInteger(target)) return 'هدف عادة نعم أو لا عدد صحيح.';
  if (target <= max) return undefined;
  return f.period === 'day' ? 'العادة اليومية بنعم أو لا هدفها 1.' : `هدف عادة نعم أو لا لا يتجاوز عدد أيام الفترة (${max}).`;
}

function scheduleErrors(f: HabitForm, errors: FormErrors): void {
  if (f.period !== 'day' && f.schedule_kind !== 'every_day') {
    errors.schedule_kind = 'الجدول الخاص يقتصر على الفترة اليومية.';
  } else if (f.schedule_kind === 'weekdays') {
    if (f.weekday_mask === null || !Number.isInteger(f.weekday_mask) || f.weekday_mask < 1 || f.weekday_mask > 127) {
      errors.weekday_mask = 'الأيام المحددة تحتاج يوماً واحداً على الأقل.';
    }
  } else if (f.schedule_kind === 'every_n_days') {
    if (f.every_n === null || !Number.isInteger(f.every_n) || f.every_n < MIN_EVERY_N || f.every_n > MAX_EVERY_N) {
      errors.every_n = `التكرار «كل N أيام» يحتاج N من ${MIN_EVERY_N} إلى ${MAX_EVERY_N}.`;
    }
    if (f.anchor_day === null || parseDay(f.anchor_day) === null) {
      errors.anchor_day = 'التكرار «كل N أيام» يحتاج يوم مرساة.';
    } else if (!inRange(f.anchor_day)) {
      errors.anchor_day = DAY_OUT_OF_RANGE;
    }
  }
}

function dayErrors(f: HabitForm, today: string, errors: FormErrors): void {
  const start = startDayError(f);
  if (start !== undefined) errors.start_day = start;
  const end = endDayError(f, today);
  if (end !== undefined) errors.end_day = end;
}

function startDayError(f: HabitForm): string | undefined {
  if (f.start_day === null) return typeof f.duration === 'number' ? 'المدة المحددة تحتاج تاريخ بداية.' : undefined;
  if (parseDay(f.start_day) === null) return 'تاريخ البداية غير صالح.';
  return inRange(f.start_day) ? undefined : DAY_OUT_OF_RANGE;
}

function endDayError(f: HabitForm, today: string): string | undefined {
  const end = effectiveEnd(f);
  if (end === null) return f.duration === 'custom' ? 'المدة المخصصة تحتاج تاريخ نهاية.' : undefined;
  const endOrd = parseDay(end);
  if (endOrd === null) return f.duration === 'custom' ? 'تاريخ النهاية غير صالح.' : undefined;
  if (!inRange(end)) return DAY_OUT_OF_RANGE;
  if (f.start_day === null) {
    // The server starts an undated habit today, so the end may not come before today.
    return end < today ? 'النهاية لا تسبق اليوم، وهو يوم البداية حين يُترك فارغاً.' : undefined;
  }
  const startOrd = parseDay(f.start_day);
  return startOrd !== null && endOrd < startOrd ? 'تاريخ النهاية قبل البداية.' : undefined;
}

function remindersError(reminders: ReminderIn[]): string | undefined {
  if (reminders.length > maxReminders) return `الحد الأقصى ${maxReminders} تذكيرات.`;
  const bad = (r: ReminderIn): boolean =>
    !CLOCK.test(r.time) || !Number.isInteger(r.days_mask) || r.days_mask < 1 || r.days_mask > 127;
  if (reminders.some(bad)) return 'كل تذكير يحتاج وقتاً بصيغة HH:mm ويوماً واحداً على الأقل.';
  return undefined;
}

export function toHabitIn(f: HabitForm): HabitIn {
  const daily = f.period === 'day';
  const kind = daily ? f.schedule_kind : 'every_day';
  return {
    title_ar: f.title_ar.trim(),
    goal_ref: f.goal_ref,
    outcome: f.outcome,
    ac_ref: f.ac_ref,
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
    polarity: f.polarity,
    identity_text: f.identity_text.trim() === '' ? null : f.identity_text.trim(),
  };
}

/** The fields that differ between what the habit was and what the form now says, and nothing else
 *  (a stored habit is patched, never rewritten). A start day left empty is never sent. */
export function toHabitPatch(original: HabitOut, f: HabitForm): HabitPatch {
  const before = toHabitIn(fromHabit(original)) as Record<string, unknown>;
  const after = toHabitIn(f) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (key === 'start_day' && after[key] === null) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
  }
  return patch as HabitPatch;
}

/** The type the form's `kind`, `polarity` and `measure` add up to. */
export function habitType(f: HabitForm): HabitType {
  if (f.polarity === 'abstain') return 'abstain';
  if (f.measure === 'average') return 'average';
  return f.kind === 'boolean' ? 'yesno' : f.kind;
}

/** Chooses a type: sets `kind`, `unit`, `polarity` and `measure`, and the fields a type fixes
 *  (abstain: daily, target 1; average: daily). A yes/no target is brought inside its period. */
export function withType(f: HabitForm, type: HabitType): HabitForm {
  const base: HabitForm = { ...f, polarity: 'build', measure: 'target' };
  switch (type) {
    case 'abstain':
      return { ...base, polarity: 'abstain', kind: 'boolean', unit: '', period: 'day', target_per_period: 1 };
    case 'average':
      return { ...base, measure: 'average', kind: 'count', unit: '', period: 'day' };
    case 'yesno': {
      const inside = Math.min(periodDays(f.period), Math.max(1, Math.round(f.target_per_period) || 1));
      return { ...base, kind: 'boolean', unit: '', target_per_period: f.kind === 'boolean' ? f.target_per_period : inside };
    }
    case 'count':
      return { ...base, kind: 'count', unit: f.unit === 'session' ? 'session' : '' };
    case 'duration':
      return { ...base, kind: 'duration', unit: f.unit === 'hour' ? 'hour' : 'min' };
  }
}

/** Chooses the length of the period by a chip (or `null`: «مستمرة»). The end day follows the chip. */
export function withDuration(f: HabitForm, choice: DurationChoice): HabitForm {
  const next: HabitForm = { ...f, duration: choice };
  if (choice === null) return { ...next, end_day: null };
  if (choice === 'custom') return next;
  return { ...next, end_day: effectiveEnd(next) };
}

/** A new start day: while a chip is chosen the end day follows it, a typed end stays where it is. */
export function withStart(f: HabitForm, day: string): HabitForm {
  const next: HabitForm = { ...f, start_day: day === '' ? null : day };
  return typeof f.duration === 'number' ? { ...next, end_day: effectiveEnd(next) } : next;
}

/** A typed end day: the chip is the one that length makes, else «مخصص»; empty is open-ended. */
export function withEnd(f: HabitForm, day: string): HabitForm {
  if (day === '') return { ...f, end_day: null, duration: null };
  return { ...f, end_day: day, duration: chipFor(f.start_day, day) ?? 'custom' };
}

/** System habits (seeded from GOAL-2031.md) change only their anchor, reminders and identity
 *  sentence. A habit of the abstain type has its kind, period and target fixed, and an average
 *  habit its kind and period. */
export function lockedFields(f: HabitForm): Set<keyof HabitForm> {
  const locked = new Set<keyof HabitForm>();
  if (f.system) {
    const editable = new Set<keyof HabitForm>(['anchor', 'reminders', 'identity_text']);
    for (const key of Object.keys(f) as (keyof HabitForm)[]) if (!editable.has(key)) locked.add(key);
  }
  if (f.polarity === 'abstain') for (const key of ['kind', 'unit', 'period', 'target_per_period'] as const) locked.add(key);
  if (f.measure === 'average') for (const key of ['kind', 'period'] as const) locked.add(key);
  return locked;
}
