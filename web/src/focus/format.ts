// The words of the focus page that the home page repeats: one place, so both say the same thing.

import { fmt } from '../lib/format';

/** Said when there is no target to measure the minutes against. */
export const NO_TARGET = 'لا هدف يومي للتركيز بعد';

/** «45 من 90 دقيقة · للوعي الذاتي»: what a score stands for. It is an estimate, not a grade. */
export function scoreDetail(minutes: number, target: number): string {
  return `${fmt.num(minutes)} من ${fmt.count(target, 'minute')} · للوعي الذاتي`;
}

/** «50 · 45 من 90 دقيقة · للوعي الذاتي». */
export function scoreLine(score: number, minutes: number, target: number): string {
  return `${fmt.num(score)} · ${scoreDetail(minutes, target)}`;
}

/** The days of the week by the bit of `weekday_mask`: 0 is Sunday and 6 is Saturday. */
export const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;

/** The mask of a set of weekday indexes (0 = Sunday). */
export function maskOf(days: readonly number[]): number {
  return days.reduce((mask, d) => mask | (1 << d), 0);
}

/** The weekday indexes of a mask, Sunday first. */
export function daysOf(mask: number): number[] {
  return WEEKDAYS.map((_, i) => i).filter((i) => (mask & (1 << i)) !== 0);
}

/** «الأحد والثلاثاء · 09:00», the time as stored (HH:mm). */
export function scheduleText(mask: number, time: string): string {
  const names = daysOf(mask).map((i) => WEEKDAYS[i]);
  const days = names.length === 7 ? 'كل يوم' : names.length > 1 ? `${names.slice(0, -1).join('، ')} و${names[names.length - 1]}` : (names[0] ?? '');
  return `${days} · ${time.replace(/\d/g, (d) => fmt.num(Number(d), { useGrouping: false }))}`;
}
