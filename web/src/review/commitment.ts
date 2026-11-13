// The commitment of a month (design 13.1, ruling 16): of the days the daily habits were due in the
// month, up to today, how many were kept. The same day rule as the week's adherence (a build habit
// keeps a day by meeting its target, an abstain habit by having no slip; a skipped or vacation day is
// in neither number), over the days of one month. Weekly and monthly habits are not days.

import { daysInMonthOf, fromOrdinal, toOrdinal } from '../domain/days';
import { periodProgress } from '../domain/habits';
import type { Day, WeekStart } from '../domain/types';
import type { HabitLogOut } from '../data/pending';
import type { HabitOut } from '../habits/types';
import { isNeutral, prepare, scheduledDays } from './week';

export interface Commitment {
  /** The due days that were kept. */
  reached: number;
  /** The days the daily habits were due in the month, up to today. */
  total: number;
}

export interface CommitmentInput {
  habits: readonly HabitOut[];
  logs: readonly HabitLogOut[];
  /** `YYYY-MM`. */
  month: string;
  today: Day;
  weekStart: WeekStart;
}

/** The days kept of the daily habits in `month` against the days due, or null when no day was due. */
export function monthCommitment({ habits, logs, month, today, weekStart }: CommitmentInput): Commitment | null {
  const first: Day = `${month}-01`;
  const ordinal = toOrdinal(first);
  const monthEnd = fromOrdinal(ordinal + daysInMonthOf(ordinal) - 1);
  const last = today < monthEnd ? today : monthEnd;
  let reached = 0;
  let total = 0;
  for (const habit of habits) {
    if (!habit.active || habit.period !== 'day') continue;
    const prepared = prepare(habit, logs);
    if (prepared === null) continue;
    const from = habit.start_day > first ? habit.start_day : first;
    const to = habit.end_day != null && habit.end_day < last ? habit.end_day : last;
    if (from > to) continue;
    for (const day of scheduledDays(prepared.spec, from, to)) {
      if (isNeutral(prepared.logs, day)) continue;
      total += 1;
      if (periodProgress(prepared.spec, prepared.logs, day, weekStart).reached) reached += 1;
    }
  }
  return total === 0 ? null : { reached, total };
}
