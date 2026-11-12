import { fmt } from '../../lib/format';
import { Chips } from '../../ui/Chips';
import { LIMITS } from './limits';
import type { DayHabit } from './useDayData';

export interface ActivityChipsProps {
  /** Today's habits. The page chooses the ones done, so the usual day costs no taps. */
  habits: readonly DayHabit[];
  selected: readonly string[];
  onChange(next: string[]): void;
  /** The list of habits cannot be read yet (offline, no saved copy): it appears with the connection. */
  unavailable?: boolean;
}

/** What the day held, from the habits: a chip each, selected when it was done, at most 12 (what
 *  `mood_logged.activities` allows). At the limit the page says so, and the other chips wait for
 *  one to be cleared. The codes go into the event. */
export function ActivityChips({ habits, selected, onChange, unavailable }: ActivityChipsProps) {
  if (unavailable) return <p class="day-note">قائمة العادات تظهر عند الاتصال</p>;
  if (habits.length === 0) return <p class="day-note">لا عادات لليوم.</p>;
  const full = selected.length >= LIMITS.activities;
  return (
    <>
      <Chips
        label="الأنشطة"
        options={habits.map((h) => ({ value: h.code, label: h.title }))}
        selected={selected}
        onChange={(next) => {
          if (next.length > LIMITS.activities) return;
          onChange(next);
        }}
      />
      {full && <p class="day-note">{`حتى ${fmt.num(LIMITS.activities)} نشاطاً`}</p>}
    </>
  );
}
