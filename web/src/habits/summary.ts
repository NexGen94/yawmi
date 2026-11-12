// The live summary beside the editor: when the habit starts and ends, and what it asks for. Pure,
// so the page and its tests read the same sentences. Weekly and monthly needs are whole units.

import { toOrdinal } from '../domain/days';
import { fmt } from '../lib/format';
import { amount } from './amount';
import type { HabitForm } from './form';
import type { HabitUnit } from './types';
import { roundUpNeed } from './useHabitsToday';

const DAYS_IN_MONTH = 30;
const PERIOD_NEED = { day: 'المطلوب يومياً', week: 'المطلوب أسبوعياً', month: 'المطلوب شهرياً' } as const;

function parse(day: string | null): number | null {
  if (day === null || day === '') return null;
  try {
    return toOrdinal(day);
  } catch {
    return null;
  }
}

/** When the habit starts, ends and how long it runs. An empty start is the day the server will use. */
export function spanLines(f: HabitForm, today: string): string[] {
  const start = f.start_day ?? today;
  const lines = [`تبدأ في ${fmt.day(start)}`];
  const end = f.end_day;
  if (end === null) return [...lines, 'مستمرة بلا نهاية'];
  lines.push(`تنتهي في ${fmt.day(end)}`);
  const from = parse(start);
  const to = parse(end);
  if (from !== null && to !== null && to >= from) lines.push(`المدة: ${fmt.count(to - from + 1, 'day')}`);
  return lines;
}

/** What the habit asks for. A daily share is shown for duration habits only: a count of times in a
 *  week is not a share of each day. */
export function needLines(f: HabitForm): string[] {
  if (f.polarity === 'abstain') return ['الأيام النظيفة تُحسب كل يوم ما لم يُسجَّل انزلاق.'];
  const target = f.target_per_period;
  if (!(target > 0)) return [];
  if (f.measure === 'average') return [`المتوسط المطلوب يومياً: ${fmt.num(target)}`, 'يُحسب من آخر 7 أيام.'];
  if (f.kind === 'boolean') {
    if (f.period === 'day') return ['المطلوب يومياً: مرة واحدة'];
    return [`${PERIOD_NEED[f.period]}: ${fmt.count(target, 'day')}`];
  }
  const unit: HabitUnit = f.unit;
  if (f.period === 'day') return [`${PERIOD_NEED.day}: ${amount(target, unit)}`];
  const lines = [`${PERIOD_NEED[f.period]}: ${amount(target, unit)}`];
  if (f.kind === 'duration') {
    const share = roundUpNeed(target / (f.period === 'week' ? 7 : DAYS_IN_MONTH), unit);
    lines.push(`${PERIOD_NEED.day}: ${amount(share, unit)}`);
  }
  return lines;
}
