import { useState } from 'preact/hooks';

import { fieldLabel } from '../../goals/format';
import type { GoalsOut } from '../../goals/types';
import { fmt } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Drawer } from '../../ui/Drawer';

interface Waiting {
  id: string;
  title: string;
  fields: string[];
}

/** What waits to be applied to Notion, from the `pending` field names the milestones and cards carry. */
function waitingOf(goals: GoalsOut): Waiting[] {
  return [...goals.milestones, ...goals.cards]
    .filter((r) => r.pending.length > 0)
    .map((r) => ({ id: r.page_id, title: r.title, fields: r.pending }));
}

/** «تعديلات معلّقة: n»: edits made here that Notion has not taken yet. Opens the list of what waits.
 *  Nothing is drawn when none waits. */
export function PendingBadge({ goals }: { goals: GoalsOut }) {
  const [open, setOpen] = useState(false);
  const count = goals.pending_edits;
  if (count <= 0) return null;
  const waiting = waitingOf(goals);
  return (
    <>
      <button type="button" class="pending-badge" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Badge tone="signal">{`تعديلات معلّقة: ${fmt.num(count)}`}</Badge>
      </button>
      <Drawer open={open} title="تعديلات معلّقة" onClose={() => setOpen(false)}>
        <p class="pending-note">تعديلات أُجريت هنا وتنتظر تطبيقها على Notion. تبقى معروضة بقيمتها الجديدة حتى تلحقها المرآة.</p>
        {waiting.length === 0 ? (
          <p class="pending-note">تفاصيل الحقول في صفحة كل هدف.</p>
        ) : (
          <ul class="pending-list">
            {waiting.map((w) => (
              <li key={w.id}>
                <a href={`/goals/${encodeURIComponent(w.id)}`}>{w.title}</a>
                <span class="pending-fields">{w.fields.map(fieldLabel).join('، ')}</span>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    </>
  );
}
