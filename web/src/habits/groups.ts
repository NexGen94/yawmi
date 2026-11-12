import type { HabitGroup } from './useHabitsToday';

/** Design section 13, ruling 14: the three groups come from the habit's anchor. */
export const HABIT_GROUPS: readonly { key: HabitGroup; title: string }[] = [
  { key: 'after_wake', title: 'بعد الاستيقاظ' },
  { key: 'free', title: 'خلال اليوم' },
  { key: 'before_sleep', title: 'قبل النوم' },
];
