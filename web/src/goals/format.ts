// Small text helpers the goals views share. A value that is not there is a dash, never 0 or NaN.

import { dayKey } from '../domain/days';
import type { Day } from '../domain/types';
import { fmt } from '../lib/format';

export const DASH = '—';

/** A ratio as a percentage, or a dash when there is none. */
export function pctOrDash(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? DASH : fmt.pct(value);
}

/** A Notion edit time (an instant) as a Riyadh day, in words. */
export function editedDay(iso: string): string {
  return fmt.day(dayKey(iso, 'Asia/Riyadh') as Day);
}

/** The fields an edit can wait on, in the words of the design (task 14's FIELD_LABELS). */
export const FIELD_LABELS: Record<string, string> = {
  done: 'الإنجاز',
  due_date: 'الموعد',
  evidence: 'الدليل',
  status: 'الحالة',
};

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;
