import { HABIT_GROUPS } from '../../habits/groups';
import { HabitRow } from '../../habits/HabitRow';
import type { HabitTodayItem } from '../../habits/useHabitsToday';

export interface HabitGroupsProps {
  items: HabitTodayItem[];
  onTick(code: string): void;
  onAdd(code: string, step: number): void;
  onUntick(code: string): void;
  onSkip(code: string): void;
}

/** The habits in three groups by their anchor (after waking, during the day, before sleep). A group
 *  with no habit is not drawn. Each row also says what its state is (`showState`). */
export function HabitGroups({ items, onTick, onAdd, onUntick, onSkip }: HabitGroupsProps) {
  return (
    <>
      {HABIT_GROUPS.map(({ key, title }) => {
        const inGroup = items.filter((item) => item.group === key);
        if (inGroup.length === 0) return null;
        return (
          <section key={key} class="habit-group">
            <h2 class="group-title">{title}</h2>
            <ul class="habit-list">
              {inGroup.map((item) => (
                <HabitRow
                  key={item.habit.code}
                  item={item}
                  showState
                  onTick={() => onTick(item.habit.code)}
                  onAdd={(step) => onAdd(item.habit.code, step)}
                  onUntick={() => onUntick(item.habit.code)}
                  onSkip={() => onSkip(item.habit.code)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
