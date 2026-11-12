import { amount } from '../../habits/amount';
import type { HabitOut } from '../../habits/types';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';

export interface VotesCountProps {
  habit: Pick<HabitOut, 'kind' | 'unit' | 'start_day'>;
  /** The sum of the `done` values since the start (for a yes/no habit: the days done). */
  total: number;
}

/** The total repetitions since the habit began: «85 دقيقة منذ 2026-11-01». Each repetition is a
 *  vote for the habit, so the number only grows. */
export function VotesCount({ habit, total }: VotesCountProps) {
  const text = habit.kind === 'boolean' ? fmt.count(total, 'day') : amount(total, habit.unit);
  return (
    <Card title="إجمالي التكرارات" class="votes-count">
      <p class="votes-total">{`${text} منذ ${habit.start_day}`}</p>
    </Card>
  );
}
