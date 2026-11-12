import { amount } from '../../habits/amount';
import type { HabitOut } from '../../habits/types';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';

export interface VotesCountProps {
  habit: Pick<HabitOut, 'kind' | 'unit' | 'start_day' | 'polarity'>;
  /** What the server totals: the sum of the `done` values since the start (a yes/no habit: the days
   *  done); for an abstain habit the clean days, since there a `done` is a slip. */
  total: number;
}

/** The total since the habit began: «85 دقيقة منذ الأحد، 1 نوفمبر 2026». Each repetition is a vote for
 *  the habit, so the number only grows. For an abstain habit it counts the clean days instead. */
export function VotesCount({ habit, total }: VotesCountProps) {
  const abstain = habit.polarity === 'abstain';
  const text = abstain || habit.kind === 'boolean' ? fmt.count(total, 'day') : amount(total, habit.unit);
  return (
    <Card title={abstain ? 'أيام نظيفة' : 'إجمالي التكرارات'} class="votes-count">
      <p class="votes-total">{`${text} منذ ${fmt.day(habit.start_day)}`}</p>
    </Card>
  );
}
