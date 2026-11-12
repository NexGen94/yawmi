// The scope switch of the habits page: which habits the list is about.
//   today: the habits scheduled today.
//   week: the open weekly habits.
//   cycle: every habit in force, scheduled today or not.
// A habit that is not in force (upcoming, ended, archived) has no today or week, so the scope never
// hides it: only the status filter does. The scope narrows the habits that are in force.

import type { HabitTodayItem } from '../../habits/useHabitsToday';
import type { StatusFilterValue } from '../../progress/state';

export type Scope = 'today' | 'week' | 'cycle';

export const SCOPES: readonly Scope[] = ['today', 'week', 'cycle'];
export const STATUSES: readonly StatusFilterValue[] = ['active', 'done', 'late', 'all'];

export const DEFAULT_SCOPE: Scope = 'today';
export const DEFAULT_STATUS: StatusFilterValue = 'active';

export function parseScope(value: unknown): Scope {
  return SCOPES.find((s) => s === value) ?? DEFAULT_SCOPE;
}

export function parseStatus(value: unknown): StatusFilterValue {
  return STATUSES.find((s) => s === value) ?? DEFAULT_STATUS;
}

const DORMANT = new Set(['upcoming', 'ended', 'archived']);

export function inScope(item: HabitTodayItem, scope: Scope): boolean {
  if (DORMANT.has(item.state)) return true;
  switch (scope) {
    case 'today':
      return item.dueToday;
    case 'week':
      return item.habit.period === 'week';
    case 'cycle':
      return true;
  }
}
