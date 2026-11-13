import { type MonthGroup, monthSentence } from '../../review/mood-stats';

/** A month in one sentence (feature 15, ruling 16): the days with a morning and an evening journal and
 *  the mean mood, for self-awareness. It holds nothing from a watch. */
export function MonthCard({ group }: { group: MonthGroup }) {
  return (
    <div class="card review-month">
      <p class="review-month-text">{monthSentence(group)}</p>
    </div>
  );
}
