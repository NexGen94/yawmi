// The five lines of the horizons view (design 4.1): today, the week, the month, the cycle and the plan.
// A line with nothing in it says «لا شيء مستحق». The wording of each line is the design's.

import { toOrdinal } from '../domain/days';
import { periodBounds } from '../domain/periods';
import type { Day } from '../domain/types';
import { counted, openCountText } from '../lib/counts';
import { fmt } from '../lib/format';
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

const habitsLeftText = (n: number): string => (n === 0 ? 'لا عادات باقية' : counted(n, 'habit', 'باقية', 'باقيتان'));
const dueMilestonesText = (n: number): string => counted(n, 'milestone', 'مستحقة', 'مستحقتان');

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

export interface CyclePosition {
  cycle: GoalsOut['cycles'][number];
  /** `work`: a day of the cycle. `review`: a day of the 7-day review week after it, which the server
   *  counts in the cycle too (`day_in_cycle` runs on through it: 58 to 64 for the first cycle). */
  phase: 'work' | 'review';
  /** The day's number in its phase: in the cycle, or in the review week. */
  index: number;
  /** The length of the phase in days: the cycle's, or the review week's (7). */
  length: number;
}

/**
 * Where the day falls in the cycles: the same rule as the server's (`current_cycle` in
 * api/yawmi/today/assemble.py): the cycle whose span, review week included, holds the day (the lowest
 * number on overlap). `undefined` before the plan, or past its last review week.
 */
export function cyclePosition(goals: GoalsOut, today: Day): CyclePosition | undefined {
  const now = toOrdinal(today);
  const cycles = [...goals.cycles].sort((a, b) => a.cycle_no - b.cycle_no);
  const cycle = cycles.find((c) => now >= toOrdinal(c.start_date) && now <= toOrdinal(c.review_end));
  if (cycle === undefined) return undefined;
  const end = toOrdinal(cycle.end_date);
  if (now <= end) return { cycle, phase: 'work', index: now - toOrdinal(cycle.start_date) + 1, length: end - toOrdinal(cycle.start_date) + 1 };
  return { cycle, phase: 'review', index: now - end, length: toOrdinal(cycle.review_end) - end };
}

/** «اليوم 15 من 57» in the cycle, «أسبوع المراجعة، اليوم 2 من 7» in its review week: said the same on
 *  every page (`joiner` sits between the two parts of the second). */
export function cycleDayText({ phase, index, length }: CyclePosition, joiner = '، '): string {
  const day = `اليوم ${fmt.num(index)} من ${fmt.num(length)}`;
  return phase === 'review' ? `أسبوع المراجعة${joiner}${day}` : day;
}

/**
 * «الدورة 1 · اليوم 15 من 57», or «الدورة 1 · أسبوع المراجعة · اليوم 2 من 7» in the review week after
 * the cycle (the server counts that week in the cycle, so its own day number runs on to 64). The
 * words come from the mirror, the same on every page; without the mirror there is the server's day
 * alone rather than a guess, and without a day just the cycle.
 */
export function cycleWords(cycle: number, dayInCycle: number | null, today: Day, goals: GoalsOut | undefined): string {
  const position = goals === undefined ? undefined : cyclePosition(goals, today);
  if (position !== undefined && position.cycle.cycle_no === cycle) return `الدورة ${fmt.num(cycle)} · ${cycleDayText(position, ' · ')}`;
  return dayInCycle === null ? `الدورة ${fmt.num(cycle)}` : `الدورة ${fmt.num(cycle)} · اليوم ${fmt.num(dayInCycle)}`;
}

/** The length of cycle `no` in days, from the mirror: the home page and the goals page say the same
 *  number (the home page had a constant of 56 while the first cycle is 57 days). */
export function cycleLengthOf(goals: GoalsOut, no: number): number | undefined {
  const cycle = goals.cycles.find((c) => c.cycle_no === no);
  return cycle === undefined ? undefined : toOrdinal(cycle.end_date) - toOrdinal(cycle.start_date) + 1;
}

function cycleLine(goals: GoalsOut, today: Day): string {
  const first = [...goals.cycles].sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  if (first === undefined) return NOTHING_DUE;
  if (toOrdinal(today) < toOrdinal(first.start_date)) return `تبدأ الدورة ${fmt.num(first.cycle_no)} في ${fmt.day(first.start_date)}`;
  const position = cyclePosition(goals, today);
  if (position === undefined) return NOTHING_DUE;
  return `الدورة ${fmt.num(position.cycle.cycle_no)}: ${cycleDayText(position)} · ${position.cycle.theme}`;
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
  return left > 0 ? `${progress} · ${daysText(left)} حتى ${fmt.day(PLAN_END)}` : progress;
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
