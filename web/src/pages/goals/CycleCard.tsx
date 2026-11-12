import { ProgressBar } from '../../charts/ProgressBar';
import type { Day } from '../../domain/types';
import { currentCycle } from '../../goals/horizons';
import type { GoalsOut } from '../../goals/types';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';

/** The cycle of today: its number, theme, the day in it and its dates. Nothing when today is in no cycle. */
export function CycleCard({ goals, today }: { goals: GoalsOut; today: Day }) {
  const current = currentCycle(goals, today);
  if (current === undefined) return null;
  const { cycle, index, length } = current;
  return (
    <Card title={`الدورة ${fmt.num(cycle.cycle_no)}`} class="cycle-card">
      <p class="cycle-theme">{cycle.theme}</p>
      <p class="cycle-day">{`اليوم ${fmt.num(index)} من ${fmt.num(length)}`}</p>
      <ProgressBar value={index / length} label="تقدّم الدورة" />
      <p class="cycle-dates">{`${fmt.day(cycle.start_date)} إلى ${fmt.day(cycle.end_date)}`}</p>
    </Card>
  );
}
