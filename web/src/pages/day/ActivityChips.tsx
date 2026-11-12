import { Chips } from '../../ui/Chips';
import type { DayHabit } from './useDayData';

export interface ActivityChipsProps {
  /** Today's habits. The page chooses the ones done, so the usual day costs no taps. */
  habits: readonly DayHabit[];
  selected: readonly string[];
  onChange(next: string[]): void;
}

/** What the day held, from the habits: a chip each, selected when it was done. The codes go into
 *  `mood_logged.activities`. */
export function ActivityChips({ habits, selected, onChange }: ActivityChipsProps) {
  if (habits.length === 0) return <p class="day-note">لا عادات لليوم.</p>;
  return (
    <Chips
      label="الأنشطة"
      options={habits.map((h) => ({ value: h.code, label: h.title }))}
      selected={selected}
      onChange={onChange}
    />
  );
}
