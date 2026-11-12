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
