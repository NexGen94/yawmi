import { fmt, type Noun } from '../lib/format';
import type { HabitUnit } from './types';

const NOUN: Record<HabitUnit, Noun> = { min: 'minute', hour: 'hour', session: 'session', '': 'time' };

/** A quantity in the habit's unit: «3 مرات», «25 دقيقة». */
export function amount(n: number, unit: HabitUnit): string {
  const text = fmt.count(n, NOUN[unit]);
  // «جلسة» and «جلستان» alone would read as a label, not a quantity.
  return n === 1 || n === 2 ? `${fmt.num(n)} ${text}` : text;
}

/** Where a period progress is placed in a sentence: 25 من 45 دقيقة اليوم. */
export const PERIOD_WORD = { day: 'اليوم', week: 'هذا الأسبوع', month: 'هذا الشهر' } as const;

/** What «late» is called for a habit: against a day for a daily one, against the pace of the week or
 *  month for the others (design 9.1: «onTrack = false»). The filter keeps the name «متأخرة». */
export function lateWord(period: keyof typeof PERIOD_WORD): string {
  return { day: 'متأخرة', week: 'دون وتيرة الأسبوع', month: 'دون وتيرة الشهر' }[period];
}
