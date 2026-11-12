import { fmt } from '../../lib/format';
import type { HabitPeriod } from '../../habits/types';
import { Badge } from '../../ui/Badge';
import type { PeriodMark } from './dayStates';

const WORDS = { met: 'تحقق', notMet: 'لم يتحقق', ongoing: 'جارٍ' } as const;
const LABEL = { week: 'الأسبوع', month: 'الشهر' } as const;

/** The outcome of each week or month of a habit judged on its period, beside the grid of days: the
 *  days of such a habit are not hits or misses, the period is. Each mark says its outcome in words. */
export function PeriodMarks({ marks, period }: { marks: PeriodMark[]; period: Exclude<HabitPeriod, 'day'> }) {
  if (marks.length === 0) return null;
  return (
    <ul class="period-marks" aria-label={`نتيجة كل ${period === 'week' ? 'أسبوع' : 'شهر'}`}>
      {marks.map((mark, i) => (
        <li key={mark.start} title={`${fmt.day(mark.start)} – ${fmt.day(mark.end)}`}>
          <span>{`${LABEL[period]} ${fmt.num(i + 1)}`}</span>
          <Badge>{WORDS[mark.outcome]}</Badge>
        </li>
      ))}
    </ul>
  );
}
