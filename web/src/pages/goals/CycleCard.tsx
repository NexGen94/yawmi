import { ProgressBar } from '../../charts/ProgressBar';
import type { Day } from '../../domain/types';
import { cycleDayText, cyclePosition } from '../../goals/horizons';
import type { GoalsOut } from '../../goals/types';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';

/** The cycle of today: its number, theme, the day in it (or in its review week) and its dates. Nothing
 *  when today is in no cycle. */
export function CycleCard({ goals, today }: { goals: GoalsOut; today: Day }) {
  const position = cyclePosition(goals, today);
  if (position === undefined) return null;
  const { cycle, index, length } = position;
  return (
    <Card title={`الدورة ${fmt.num(cycle.cycle_no)}`} class="cycle-card">
      <div class="cycle-row">
        <p class="cycle-theme">{cycle.theme}</p>
        <p class="cycle-day">{cycleDayText(position)}</p>
      </div>
      <ProgressBar value={index / length} label={position.phase === 'review' ? 'تقدّم أسبوع المراجعة' : 'تقدّم الدورة'} />
      <p class="cycle-dates">
        {position.phase === 'review'
          ? `${fmt.day(cycle.review_start)} إلى ${fmt.day(cycle.review_end)}`
          : `${fmt.day(cycle.start_date)} إلى ${fmt.day(cycle.end_date)}`}
      </p>
    </Card>
  );
}
