// The state of a habit on a day (design section 9.1): one of six, by the first rule that holds. It is
// the browser's twin of `habit_state` in `api/yawmi/habits/state.py`; both read the same cases from
// `contracts/view-cases/habit_state.json`, so they cannot drift apart.

import { toOrdinal, fromOrdinal } from '../domain/days';
import { periodProgress } from '../domain/habits';
import { isScheduled } from '../domain/periods';
import type { Day, HabitLog, HabitSpec, WeekStart } from '../domain/types';
import { habitSpecOf } from '../habits/spec';
import type { HabitOut } from '../habits/types';

export type HabitState = 'archived' | 'upcoming' | 'ended' | 'done' | 'late' | 'active';

/** The fields the function reads, and no others: the `habit` object of the shared cases. A whole
 *  `HabitOut` is a valid input. */
export type HabitStateInput = Pick<
  HabitOut,
  | 'kind'
  | 'unit'
  | 'target_per_period'
  | 'period'
  | 'schedule_kind'
  | 'weekday_mask'
  | 'every_n'
  | 'anchor_day'
  | 'start_day'
  | 'end_day'
  | 'polarity'
  | 'active'
>;

/** The last scheduled day before `today`, no earlier than the start; null when there is none. */
function lastScheduledBefore(spec: HabitSpec, today: Day): Day | null {
  const first = toOrdinal(spec.startDay);
  for (let ord = toOrdinal(today) - 1; ord >= first; ord -= 1) {
    const day = fromOrdinal(ord);
    if (isScheduled(day, spec)) return day;
  }
  return null;
}

export function habitState(
  habit: HabitStateInput,
  logs: readonly HabitLog[],
  today: Day,
  weekStart: WeekStart,
): HabitState {
  if (!habit.active) return 'archived';
  if (habit.start_day > today) return 'upcoming';
  if (habit.end_day != null && habit.end_day < today) return 'ended';

  const spec = habitSpecOf(habit);
  const abstain = spec.polarity === 'abstain';

  // An abstain habit has nothing to reach: it is never done.
  const progress = periodProgress(spec, logs, today, weekStart);
  if (!abstain && progress.reached) return 'done';

  if (spec.period === 'day') {
    if (abstain) {
      const yesterday = fromOrdinal(toOrdinal(today) - 1);
      return logs.some((log) => log.status === 'done' && (log.day === today || log.day === yesterday)) ? 'late' : 'active';
    }
    const last = lastScheduledBefore(spec, today);
    if (last !== null && !logs.some((log) => log.day === last && ['done', 'skip', 'vacation'].includes(log.status))) {
      return 'late';
    }
    return 'active';
  }
  return progress.onTrack ? 'active' : 'late';
}

export type StatusFilterValue = 'active' | 'done' | 'late' | 'all';

/** «فعّالة» is active; «منجزة» is done and ended; «متأخرة» is late; «الكل» is all six states. */
export function matchesFilter(state: HabitState, filter: StatusFilterValue): boolean {
  switch (filter) {
    case 'active':
      return state === 'active';
    case 'done':
      return state === 'done' || state === 'ended';
    case 'late':
      return state === 'late';
    case 'all':
      return true;
  }
}

const FILTERS: readonly StatusFilterValue[] = ['active', 'done', 'late', 'all'];

export function countByFilter(states: readonly HabitState[]): Record<StatusFilterValue, number> {
  const counts: Record<StatusFilterValue, number> = { active: 0, done: 0, late: 0, all: 0 };
  for (const state of states) for (const filter of FILTERS) if (matchesFilter(state, filter)) counts[filter] += 1;
  return counts;
}
