import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

import { fmt } from '../../lib/format';
import { impactSentence, type LateItem } from '../../progress/impact';
import { Badge } from '../../ui/Badge';
import { CheckRow } from '../../ui/CheckRow';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';

/** How many items show before «عرض الكل» (design 9.2). */
export const SHOWN = 5;

export interface LateSectionProps {
  items: readonly LateItem[];
  /** The goals are still being read: what is late in them is not known yet, so «no late» is not said. */
  pending?: boolean;
  /** The check mark of a late habit: logs it for today, as the row of «العادات المستحقة» does. */
  onTick(code: string): void;
}

const keyOf = (item: LateItem): string => {
  switch (item.kind) {
    case 'milestone':
      return `m:${item.pageId}`;
    case 'goal_pace':
      return `g:${item.ref}`;
    default:
      return `h:${item.code}`;
  }
};

/** An ISO day or an outcome code inside an Arabic sentence is isolated left to right, so «2026-11-09»
 *  is not read backwards. The text itself is unchanged. */
function Sentence({ text }: { text: string }) {
  const nodes: ComponentChildren[] = [];
  const isolated = /\d{4}-\d{2}-\d{2}|O\d+/g;
  let from = 0;
  for (const match of text.matchAll(isolated)) {
    const at = match.index;
    if (at > from) nodes.push(text.slice(from, at));
    nodes.push(
      <bdi key={at} dir="ltr">
        {match[0]}
      </bdi>,
    );
    from = at + match[0].length;
  }
  if (from < text.length) nodes.push(text.slice(from));
  return <>{nodes}</>;
}

function hrefOf(item: Exclude<LateItem, { kind: 'habit_period' | 'habit_daily' }>): string {
  if (item.kind === 'abstain_slip') return `/habits/${encodeURIComponent(item.code)}`;
  return `/goals/${encodeURIComponent(item.kind === 'milestone' ? item.pageId : item.ref)}`;
}

const LATE = <Badge tone="signal">متأخر</Badge>;

/** One late item: a habit with a check mark (not an abstain habit, which has nothing to tick), a
 *  milestone or a goal as a link to its page. Each says «متأخر» in words and its impact sentence. */
function LateRow({ item, onTick }: { item: LateItem; onTick(code: string): void }) {
  const sentence = impactSentence(item);
  if (item.kind === 'habit_period' || item.kind === 'habit_daily') {
    return (
      <li class="late-item">
        <CheckRow
          checked={false}
          label={item.title}
          note={<Sentence text={sentence} />}
          badge={LATE}
          hint="تسجيل العادة لهذا اليوم"
          onToggle={() => onTick(item.code)}
        />
      </li>
    );
  }
  const href = hrefOf(item);
  return (
    <li class="late-item">
      <a class="late-link" href={href}>
        <span class="late-head">
          <span class="late-title">{item.title}</span>
          {LATE}
        </span>
        <span class="late-sentence">
          <Sentence text={sentence} />
        </span>
      </a>
    </li>
  );
}

/** «المتأخر وغير المنجز»: the milestones past their day, the late habits and the goals under their
 *  pace, in that order; five of them, then «عرض الكل». */
export function LateSection({ items, pending = false, onTick }: LateSectionProps) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <Card title="المتأخر وغير المنجز" class="late-section">
      {shown.length > 0 && (
        <ul class="late-list">
          {shown.map((item) => (
            <LateRow key={keyOf(item)} item={item} onTick={onTick} />
          ))}
        </ul>
      )}
      {items.length === 0 && pending && <Skeleton blockSize="var(--hit)" />}
      {items.length === 0 && !pending && <p class="late-empty">لا متأخرات اليوم.</p>}
      {!all && items.length > SHOWN && (
        <button type="button" class="btn btn-quiet" onClick={() => setAll(true)}>
          {`عرض الكل (${fmt.num(items.length)})`}
        </button>
      )}
    </Card>
  );
}
