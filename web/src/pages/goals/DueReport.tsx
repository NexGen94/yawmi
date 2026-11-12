import type { Day } from '../../domain/types';
import { type DueItem, dueReport, relativeDays } from '../../goals/due';
import { NOTHING_DUE } from '../../goals/horizons';
import type { MilestoneFull } from '../../goals/types';
import { fmt } from '../../lib/format';
import { Badge } from '../../ui/Badge';

/** How many coming milestones are listed; the late ones are always all listed. */
export const UPCOMING_SHOWN = 12;

function Row({ item }: { item: DueItem }) {
  const { milestone, offset } = item;
  return (
    <li class="due-row" data-due={milestone.page_id}>
      <span class="due-main">
        <a href={`/goals/${encodeURIComponent(milestone.page_id)}`}>{milestone.title}</a>
        {milestone.outcome_code !== null && <Badge>{milestone.outcome_code}</Badge>}
      </span>
      <span class="due-meta">
        <span>{milestone.due_date === null ? '' : fmt.day(milestone.due_date)}</span>
        <Badge tone={offset < 0 ? 'signal' : 'neutral'}>{relativeDays(offset)}</Badge>
      </span>
    </li>
  );
}

/** «الأقرب استحقاقاً»: the late milestones first (the most late first), then the coming ones by date. */
export function DueReport({ milestones, today }: { milestones: readonly MilestoneFull[]; today: Day }) {
  const { overdue, upcoming } = dueReport(milestones, today);
  if (overdue.length === 0 && upcoming.length === 0) return <p class="due-none">{NOTHING_DUE}</p>;
  const shown = upcoming.slice(0, UPCOMING_SHOWN);
  return (
    <div class="due">
      {overdue.length > 0 && (
        <section aria-labelledby="due-late">
          <h3 id="due-late" class="due-heading">{`متأخرة (${fmt.num(overdue.length)})`}</h3>
          <ol class="due-list">
            {overdue.map((item) => (
              <Row key={item.milestone.page_id} item={item} />
            ))}
          </ol>
        </section>
      )}
      {shown.length > 0 && (
        <section aria-labelledby="due-next">
          <h3 id="due-next" class="due-heading">القادمة</h3>
          <ol class="due-list">
            {shown.map((item) => (
              <Row key={item.milestone.page_id} item={item} />
            ))}
          </ol>
          {upcoming.length > shown.length && (
            <p class="due-more">{`تُعرض أقرب ${fmt.num(shown.length)} محطة من ${fmt.num(upcoming.length)}.`}</p>
          )}
        </section>
      )}
    </div>
  );
}
