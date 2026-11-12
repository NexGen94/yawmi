import { HabitRow } from '../../habits/HabitRow';
import type { HabitGroup, HabitTodayItem } from '../../habits/useHabitsToday';
import { Card } from '../../ui/Card';

export interface DueHabitsProps {
  items: HabitTodayItem[];
  onTick(code: string): void;
  onAdd(code: string, step: number): void;
  onUntick(code: string): void;
  onSkip(code: string): void;
}

/** Design section 13, ruling 14: the three groups come from the habit's anchor. */
const GROUPS: readonly { key: HabitGroup; title: string }[] = [
  { key: 'after_wake', title: 'بعد الاستيقاظ' },
  { key: 'free', title: 'خلال اليوم' },
  { key: 'before_sleep', title: 'قبل النوم' },
];

/** The habits due today in three groups, each row with its one-tap actions. A group with no
 *  habit is not drawn. */
export function DueHabits({ items, onTick, onAdd, onUntick, onSkip }: DueHabitsProps) {
  return (
    <Card title="العادات المستحقة" class="due-habits">
      {GROUPS.map(({ key, title }) => {
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
