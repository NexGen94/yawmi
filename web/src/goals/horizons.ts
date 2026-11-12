// The five lines of the horizons view (design 4.1): today, the week, the month, the cycle and the plan.
// A line with nothing in it says «لا شيء مستحق». The wording of each line is the design's.

import { toOrdinal } from '../domain/days';
import { periodBounds } from '../domain/periods';
import type { Day } from '../domain/types';
import { fmt } from '../lib/format';
import { openCountText } from '../pages/home/DaySummary';
import { dueReport } from './due';
import { type GoalsOut, PLAN_END } from './types';

export type HorizonKey = 'day' | 'week' | 'month' | 'cycle' | 'plan';

export interface HorizonLine {
  key: HorizonKey;
  label: string;
  /** `null`: not known yet (the day line waits for the journal and the habits). */
  text: string | null;
}

export const NOTHING_DUE = 'لا شيء مستحق';

export interface HorizonInput {
  goals: GoalsOut;
  today: Day;
  /** Priorities of the morning still open today, or null while unknown. */
  openPriorities: number | null;
  /** Habits still to do today, or null while unknown. */
  habitsLeft: number | null;
}

/** «عادة واحدة باقية»، «عادتان باقيتان»، «3 عادات باقية»، «11 عادة باقية». */
function habitsLeftText(n: number): string {
  if (n === 0) return 'لا عادات باقية';
  if (n === 1) return 'عادة واحدة باقية';
  if (n === 2) return 'عادتان باقيتان';
  return n <= 10 ? `${fmt.num(n)} عادات باقية` : `${fmt.num(n)} عادة باقية`;
}

/** «محطة واحدة مستحقة»، «محطتان مستحقتان»، «4 محطات مستحقة»، «11 محطة مستحقة». */
function dueMilestonesText(n: number): string {
  if (n === 1) return 'محطة واحدة مستحقة';
  if (n === 2) return 'محطتان مستحقتان';
  return n <= 10 ? `${fmt.num(n)} محطات مستحقة` : `${fmt.num(n)} محطة مستحقة`;
}

function dayLine(openPriorities: number | null, habitsLeft: number | null): string | null {
  if (openPriorities === null || habitsLeft === null) return null;
  if (openPriorities === 0 && habitsLeft === 0) return NOTHING_DUE;
  return `${openCountText(openPriorities)}، و${habitsLeftText(habitsLeft)}`;
}

/** The milestones still ahead (today included) up to the last day of the period. The late ones are
 *  the due report's, not the period's. */
function dueIn(goals: GoalsOut, today: Day, period: 'week' | 'month') {
  const end = periodBounds(today, period, 'sun').end;
  return dueReport(goals.milestones, today).upcoming.filter((i) => i.milestone.due_date !== null && i.milestone.due_date <= end);
}

/** The cycle the day falls in, with the day's number in it and the cycle's length. */
export function currentCycle(
  goals: GoalsOut,
  today: Day,
): { cycle: GoalsOut['cycles'][number]; index: number; length: number } | undefined {
  const now = toOrdinal(today);
  const cycle = goals.cycles.find((c) => now >= toOrdinal(c.start_date) && now <= toOrdinal(c.end_date));
  if (cycle === undefined) return undefined;
  return { cycle, index: now - toOrdinal(cycle.start_date) + 1, length: toOrdinal(cycle.end_date) - toOrdinal(cycle.start_date) + 1 };
}

function cycleLine(goals: GoalsOut, today: Day): string {
  const first = [...goals.cycles].sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  if (first === undefined) return NOTHING_DUE;
  if (toOrdinal(today) < toOrdinal(first.start_date)) return `تبدأ الدورة ${fmt.num(first.cycle_no)} في ${fmt.day(first.start_date)}`;
  const current = currentCycle(goals, today);
  if (current === undefined) return NOTHING_DUE;
  return `الدورة ${fmt.num(current.cycle.cycle_no)}: اليوم ${fmt.num(current.index)} من ${fmt.num(current.length)} · ${current.cycle.theme}`;
}

/** «1877 يوماً»: the count of days is written without a grouping comma, as the design's line is. */
function daysText(n: number): string {
  return fmt.count(n, 'day').replace(fmt.num(n), fmt.num(n, { useGrouping: false }));
}

function planLine(goals: GoalsOut, today: Day): string {
  const total = goals.milestones.length;
  if (total === 0) return NOTHING_DUE;
  const done = goals.milestones.filter((m) => m.done).length;
  const left = toOrdinal(PLAN_END) - toOrdinal(today);
  const progress = `${fmt.num(done)} من ${fmt.num(total)} محطة`;
  return left > 0 ? `${progress} · ${daysText(left)} حتى ${PLAN_END}` : progress;
}

export function horizonLines({ goals, today, openPriorities, habitsLeft }: HorizonInput): HorizonLine[] {
  const week = dueIn(goals, today, 'week');
  const month = dueIn(goals, today, 'month');
  const nearest = week[0]?.milestone.title;
  return [
    { key: 'day', label: 'اليوم', text: dayLine(openPriorities, habitsLeft) },
    {
      key: 'week',
      label: 'الأسبوع',
      text: week.length === 0 || nearest === undefined ? NOTHING_DUE : `${dueMilestonesText(week.length)}، أقربها ${nearest}`,
    },
    { key: 'month', label: 'الشهر', text: month.length === 0 ? NOTHING_DUE : dueMilestonesText(month.length) },
    { key: 'cycle', label: 'الدورة', text: cycleLine(goals, today) },
    { key: 'plan', label: 'الخطة', text: planLine(goals, today) },
  ];
}
