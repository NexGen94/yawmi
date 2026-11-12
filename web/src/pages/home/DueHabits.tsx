import { HABIT_GROUPS } from '../../habits/groups';
import { HabitRow } from '../../habits/HabitRow';
import type { HabitTodayItem } from '../../habits/useHabitsToday';
import { Card } from '../../ui/Card';

export interface DueHabitsProps {
  items: HabitTodayItem[];
  onTick(code: string): void;
  onAdd(code: string, step: number): void;
  onUntick(code: string): void;
  onSkip(code: string): void;
}

/** The habits due today in three groups, each row with its one-tap actions. A group with no
 *  habit is not drawn. */
export function DueHabits({ items, onTick, onAdd, onUntick, onSkip }: DueHabitsProps) {
  return (
    <Card title="العادات المستحقة" class="due-habits">
      {HABIT_GROUPS.map(({ key, title }) => {
        const inGroup = items.filter((item) => item.group === key);
        if (inGroup.length === 0) return null;
        return (
          <section key={key} class="habit-group">
            <h3 class="group-title">{title}</h3>
            <ul class="habit-list">
              {inGroup.map((item) => (
                <HabitRow
                  key={item.habit.code}
                  item={item}
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
    </Card>
  );
}
