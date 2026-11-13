import { toOrdinal } from '../../domain/days';
import type { Day } from '../../domain/types';
import { relativeDays } from '../../goals/due';
import type { MilestoneFull } from '../../goals/types';
import { PLAN_END, PLAN_START } from '../../goals/types';
import { OFFLINE_NOTE } from '../../goals/edits';
import { Badge } from '../../ui/Badge';
import { EditField } from './EditField';

export type MilestoneEditInput = { done: boolean } | { due_date: string } | { evidence: string };

export interface MilestoneListProps {
  milestones: MilestoneFull[];
  today: Day;
  /** Editing needs a connection (design 13.1, ruling 22). */
  online: boolean;
  /** The title is a link to the milestone's own page (not on that page). */
  linked: boolean;
  /** Rejects with an `EditError` when the edit did not happen. */
  onEdit(milestone: MilestoneFull, change: MilestoneEditInput): Promise<void>;
}

const byDate = (a: MilestoneFull, b: MilestoneFull): number => {
  if (a.due_date === b.due_date) return 0;
  if (a.due_date === null) return 1;
  if (b.due_date === null) return -1;
  return a.due_date.localeCompare(b.due_date);
};

/** The milestones of a goal, by date, each with the three values that can be edited here: done, the
 *  due date and the evidence (design 13.1, ruling 4). Closing is the toggle: nothing is deleted. */
export function MilestoneList({ milestones, today, online, linked, onEdit }: MilestoneListProps) {
  if (milestones.length === 0) return <p class="gd-none">لا محطات لهذا الهدف.</p>;
  return (
    <ul class="ms-list">
      {[...milestones].sort(byDate).map((m) => {
        const late = !m.done && m.due_date !== null && toOrdinal(m.due_date) < toOrdinal(today);
        return (
          <li key={m.page_id} class="ms-row" data-milestone={m.page_id}>
            <div class="ms-head">
              {linked ? <a href={`/goals/${encodeURIComponent(m.page_id)}`}>{m.title}</a> : <span class="ms-title">{m.title}</span>}
              {late && m.due_date !== null && <Badge tone="signal">{relativeDays(toOrdinal(m.due_date) - toOrdinal(today))}</Badge>}
            </div>
            {m.criterion && <p class="ms-criterion">{m.criterion}</p>}
            <div class="ms-fields">
              <EditField
                kind="toggle"
                label="منجزة"
                context={m.title}
                value={m.done}
                pending={m.pending.includes('done')}
                disabled={!online}
                quietOffline
                onSave={(done) => onEdit(m, { done })}
              />
              <EditField
                kind="date"
                label="الموعد"
                context={m.title}
                value={m.due_date}
                min={PLAN_START}
                max={PLAN_END}
                pending={m.pending.includes('due_date')}
                disabled={!online}
                quietOffline
                onSave={(due_date) => onEdit(m, { due_date })}
              />
              <EditField
                kind="text"
                label="الدليل"
                context={m.title}
                value={m.evidence}
                maxLength={500}
                pending={m.pending.includes('evidence')}
                disabled={!online}
                quietOffline
                onSave={(evidence) => onEdit(m, { evidence })}
              />
            </div>
            {!online && <p class="edit-offline">{OFFLINE_NOTE}</p>}
          </li>
        );
      })}
    </ul>
  );
}
