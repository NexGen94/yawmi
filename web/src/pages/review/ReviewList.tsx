import type { components } from '../../api/schema';
import { acceptInsight, UNAVAILABLE_TEXT } from '../../ai/guard';
import { InsightCard } from '../../ai/InsightCard';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';

type InsightOut = components['schemas']['InsightOut'];

export interface ReviewListProps {
  /** The stored weekly reviews, newest first. */
  items: readonly InsightOut[];
  /** `ai_lines`. */
  maxLines: 1 | 2;
}

/** «المراجعات السابقة»: the stored weekly reviews, each under the week it was made for (its first day).
 *  A row stored before the cards existed shows its words and no card; one that breaks the limits of
 *  a reply is not shown. */
export function ReviewList({ items, maxLines }: ReviewListProps) {
  return (
    <Card title="المراجعات السابقة">
      {items.length === 0 ? (
        <p class="review-none">لا مراجعات سابقة</p>
      ) : (
        <ul class="review-previous">
          {items.map((item) => {
            const insight = acceptInsight(item, maxLines, { cardsOptional: true });
            return (
              <li key={item.id}>
                <Disclosure summary={`أسبوع ${fmt.dayShort(item.day)}`}>
                  {insight === null ? <p class="ai-note">{UNAVAILABLE_TEXT}</p> : <InsightCard insight={insight} maxLines={maxLines} />}
                </Disclosure>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
