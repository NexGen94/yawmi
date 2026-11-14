// The grid on a habit's page: the 56 days of the cycle, what each day was, in the states the
// `Heatmap` knows (each has a word and a shape, so colour never carries it alone), and for a weekly
// or monthly habit the outcome of each period beside it.
//
// A weekly or monthly habit is judged on its period, not on its days: a week met in two sessions
// has five days with nothing logged and none of them is a miss. Only a scheduled day of a daily
// habit that passed with no log is marked «لم يُنجز».

import { fromOrdinal, toOrdinal } from '../../domain/days';
import { periodProgress } from '../../domain/habits';
import { isScheduled, periodBounds } from '../../domain/periods';
import type { Day } from '../../domain/types';
import type { DayState } from '../../charts/Heatmap';
import { toDomainLogs, type HabitLogOut } from '../../data/pending';
import { habitSpecOf } from '../../habits/spec';
import type { HabitOut } from '../../habits/types';

/** The days of the grid when the length of the cycle is not known: 56, the plan's default of eight
 *  weeks. The cycles of the mirror are not all that long (the first is 57 days, the rest 84), so the
 *  page passes the length the mirror gives, the same one the home and goals pages say. */
export const GRID_DAYS = 56;
const WEEK_START = 'sun';

/**
 * The first day of the grid. In the plan's cycle it is day 1: `today - (dayInCycle - 1)`. Without a
 * day in the cycle (the plan does not say, or says something that is not one of its 56 days) it is
 * the last 56 days ending today, and `cycle` is false so the page can title it as that.
 */
export function gridStart(
  today: Day,
  dayInCycle: number | null | undefined,
  length: number = GRID_DAYS,
): { first: Day; cycle: boolean; days: number } {
  const inCycle = typeof dayInCycle === 'number' && Number.isInteger(dayInCycle) && dayInCycle >= 1 && dayInCycle <= length;
  // In the cycle the grid is the whole cycle; outside it, the last 56 days ending today.
  const days = inCycle ? length : GRID_DAYS;
  const back = inCycle ? dayInCycle - 1 : GRID_DAYS - 1;
  return { first: fromOrdinal(toOrdinal(today) - back), cycle: inCycle, days };
}

export interface GridDay {
  day: Day;
  state: DayState;
  note?: string;
  current?: boolean;
}

/**
 * Each of the `length` days (56 by default) from `first`, oldest first:
 * - `future`: after today;
 * - `off`: not scheduled (before the start, after the end, or off the habit's days);
 * - `skipped`: a skip or a vacation;
 * - `done` / `missed`: for a daily habit, logged done (a count or duration short of the day's target
 *   is `missed`), or a scheduled past day with no log;
 * - `none`: a weekly or monthly habit's day with nothing logged, and today with nothing logged yet.
 * An abstain habit is the other way round: a scheduled day is kept (`done`) unless a slip is logged,
 * and a slip is `missed`.
 */
export function dayStates(habit: HabitOut, logs: readonly HabitLogOut[], first: Day, today: Day, length: number = GRID_DAYS): GridDay[] {
  const spec = habitSpecOf(habit, today);
  const abstain = habit.polarity === 'abstain';
  const byDay = new Map(logs.filter((l) => l.habit_code === habit.code).map((l) => [l.day, l]));
  const days: GridDay[] = [];
  for (let ord = toOrdinal(first); ord < toOrdinal(first) + length; ord += 1) {
    const day = fromOrdinal(ord);
    const cell: GridDay = { day, state: stateOf(day) };
    if (day === today) {
      cell.current = true;
      if (cell.state === 'none') cell.note = 'اليوم: لم يُسجَّل بعد';
    }
    days.push(cell);
  }
  return days;

  function stateOf(day: Day): DayState {
    if (day > today) return 'future';
    if (!isScheduled(day, spec)) return 'off';
    const log = byDay.get(day);
    if (log?.status === 'skip' || log?.status === 'vacation') return 'skipped';
    if (abstain) return log?.status === 'done' ? 'missed' : 'done';
    if (log?.status === 'done') {
      const short = spec.period === 'day' && habit.kind !== 'boolean' && log.value != null && Number(log.value) < habit.target_per_period;
      return short ? 'missed' : 'done';
    }
    if (spec.period !== 'day' || day === today) return 'none';
    return 'missed';
  }
}

export interface PeriodMark {
  start: Day;
  end: Day;
  /** `met`: the period's target is reached. `notMet`: it ended short. `ongoing`: it is still open and short. */
  outcome: 'met' | 'notMet' | 'ongoing';
}

/** The outcome of each week or month that touches the grid, from the first that holds a day of the
 *  habit up to the current one. Empty for a daily habit. */
export function periodMarks(habit: HabitOut, logs: readonly HabitLogOut[], first: Day, today: Day): PeriodMark[] {
  if (habit.period === 'day') return [];
  const spec = habitSpecOf(habit, today);
  const domainLogs = toDomainLogs([...logs], habit.code);
  const from = first > habit.start_day ? first : habit.start_day;
  const marks: PeriodMark[] = [];
  // A habit that has ended has no period after its last day.
  const limit = habit.end_day != null && habit.end_day < today ? habit.end_day : today;
  let at = from;
  while (at <= limit) {
    const { start, end } = periodBounds(at, habit.period, WEEK_START);
    const through = end < limit ? end : limit;
    const reached = periodProgress(spec, domainLogs, through, WEEK_START).reached;
    const outcome = reached ? 'met' : end < today || limit < today ? 'notMet' : 'ongoing';
    marks.push({ start: start < habit.start_day ? habit.start_day : start, end, outcome });
    at = fromOrdinal(toOrdinal(end) + 1);
  }
  return marks;
}
