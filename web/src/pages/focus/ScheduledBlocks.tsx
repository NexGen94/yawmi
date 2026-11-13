import type { FocusPlanOut } from '../../focus/calc';
import { scheduleText } from '../../focus/format';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';

/** The plans that have days and a time: the blocks of the week (design 4, feature 27). The server
 *  sends one reminder at the time of each, unless a session already began near it. */
export function ScheduledBlocks({ plans }: { plans: FocusPlanOut[] }) {
  const blocks = plans.filter((p) => p.active && p.weekday_mask !== null && p.start_time !== null);
  return (
    <Card title="الكتل المجدولة" class="focus-blocks">
      {blocks.length === 0 ? (
        <>
          <p class="focus-note">لا كتل مجدولة بعد</p>
          <a class="btn btn-quiet" href="#focus-plans">
            جدولة كتلة
          </a>
        </>
      ) : (
        <ul class="focus-block-list">
          {blocks.map((p) => (
            <li key={p.id}>
              <span class="focus-plan-title">
                <bdi>{p.title_ar}</bdi>
              </span>
              <span class="focus-note">{` · ${scheduleText(p.weekday_mask ?? 0, p.start_time ?? '')} · ${fmt.count(p.minutes, 'minute')}`}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
