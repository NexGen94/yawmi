import { useHabitsToday } from '../../habits/useHabitsToday';
import { horizonLines } from '../../goals/horizons';
import type { GoalsOut } from '../../goals/types';
import type { Day } from '../../domain/types';
import { useDayEntries } from '../home/useDayEntries';
import { prioritiesOf } from '../home/DaySummary';

/** The five horizons: today, the week, the month, the cycle and the plan, one line each. The day line
 *  reads today's journal and habits, so they are fetched only while this view is open. */
export function Horizons({ goals, today }: { goals: GoalsOut; today: Day }) {
  const habits = useHabitsToday();
  const entries = useDayEntries(habits.day);
  const habitsKnown = habits.state === 'ready' || (habits.state === 'offline' && habits.stale);
  const entriesKnown = entries.state === 'ready' || (entries.state === 'offline' && entries.stale);
  const known = habitsKnown && entriesKnown;
  const open = prioritiesOf(entries.morning, entries.evening).filter((p) => p.state === 'open').length;
  const lines = horizonLines({
    goals,
    today,
    openPriorities: known ? open : null,
    habitsLeft: known ? habits.badge : null,
  });
  const settled = habits.state === 'error' || entries.state === 'error' || habits.state === 'offline' || entries.state === 'offline';

  return (
    <ul class="horizons">
      {lines.map((line) => {
        const text = line.text ?? (settled ? 'يظهر عند الاتصال' : 'جارٍ التحميل');
        // The cycle line already begins with its own name («الدورة 1: ...»).
        const named = line.key === 'cycle' && text.startsWith('الدورة');
        return (
          <li key={line.key} class="horizon" data-horizon={line.key}>
            {named ? null : (
              <>
                <strong class="horizon-label">{`${line.label}:`}</strong>{' '}
              </>
            )}
            {text}
          </li>
        );
      })}
    </ul>
  );
}
