// The days of the grid on a habit's page: what each of the last days was, in the four states the
// `Heatmap` knows. Each state has a word and a shape in the grid, so colour never carries it alone.

import { fromOrdinal, toOrdinal } from '../../domain/days';
import { isScheduled } from '../../domain/periods';
import type { Day } from '../../domain/types';
import type { HabitLogOut } from '../../data/pending';
import type { DayState } from '../../charts/Heatmap';
import { habitSpecOf } from '../../habits/spec';
import type { HabitOut } from '../../habits/types';

/** The days of the grid: the last 56, ending today (a cycle). */
export const GRID_DAYS = 56;

/**
 * Each of the last `GRID_DAYS` days, oldest first:
 * - `off`: before the start, after the end, not scheduled that day, or today with nothing logged
 *   yet (a day is judged once it is over);
 * - `done`: logged done (a count or duration short of the day's target is `missed`);
 * - `skipped`: a skip or a vacation;
 * - `missed`: a scheduled day that passed with no log, or logged `missed`.
 * An abstain habit is the other way round: a scheduled day is kept (`done`) unless a slip is logged,
 * and a slip is `missed`.
 */
export function dayStates(habit: HabitOut, logs: readonly HabitLogOut[], today: Day): { day: Day; state: DayState }[] {
  const spec = habitSpecOf(habit, today);
  const abstain = habit.polarity === 'abstain';
  const byDay = new Map(logs.filter((l) => l.habit_code === habit.code).map((l) => [l.day, l]));
  const first = toOrdinal(today) - (GRID_DAYS - 1);
  const days: { day: Day; state: DayState }[] = [];
  for (let ord = first; ord <= toOrdinal(today); ord += 1) {
    const day = fromOrdinal(ord);
    days.push({ day, state: stateOf(day) });
  }
  return days;

  function stateOf(day: Day): DayState {
    if (!isScheduled(day, spec)) return 'off';
    const log = byDay.get(day);
    if (log?.status === 'skip' || log?.status === 'vacation') return 'skipped';
    if (abstain) return log?.status === 'done' ? 'missed' : 'done';
    if (log?.status === 'done') {
      const short = spec.period === 'day' && habit.kind !== 'boolean' && log.value != null && Number(log.value) < habit.target_per_period;
      return short ? 'missed' : 'done';
    }
    if (log?.status === 'missed') return 'missed';
    return day < today ? 'missed' : 'off';
  }
}
