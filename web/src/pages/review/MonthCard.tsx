import { ratioPct } from '../../charts/scale';
import { fmt } from '../../lib/format';
import type { Commitment } from '../../review/commitment';
import { type MonthGroup, monthSentence } from '../../review/mood-stats';

export interface MonthCardProps {
  group: MonthGroup;
  /** The habit days kept in the month; absent when no daily habit was due. */
  commitment?: Commitment | null;
}

/** A month in one sentence (feature 15, ruling 16): the days with a morning and an evening journal and
 *  the mean mood, for self-awareness; and, in a line of its own, the commitment: the days the daily
 *  habits were kept over the days they were due, as a percent. It holds nothing from a watch. */
export function MonthCard({ group, commitment }: MonthCardProps) {
  return (
    <div class="card review-month">
      <p class="review-month-text">{monthSentence(group)}</p>
      {commitment != null && (
        <p class="review-month-commitment">{`الالتزام بالعادات اليومية: ${ratioPct(commitment.reached / commitment.total)} (${fmt.num(commitment.reached)} من ${fmt.num(commitment.total)})`}</p>
      )}
    </div>
  );
}
