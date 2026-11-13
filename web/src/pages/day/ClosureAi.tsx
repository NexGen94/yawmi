import { api } from '../../api/client';
import { unwrap } from '../../api/unwrap';
import { ConsentNotice } from '../../ai/ConsentDialog';
import { DeeperBlock } from '../../ai/DeeperBlock';
import { acceptInsight, type GroundedInsight, UNAVAILABLE_TEXT } from '../../ai/guard';
import { InsightCard } from '../../ai/InsightCard';
import { useQuery } from '../../data/query';
import type { Day } from '../../domain/types';
import { OFFLINE_NOTE } from '../../lib/notes';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';

/** What the summary of the closed day is doing: not asked, waiting, shown, or why it is not. */
export type Summary =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ok'; insight: GroundedInsight }
  | { kind: 'consent' }
  | { kind: 'offline' }
  | { kind: 'error' };

export interface ClosureAiProps {
  day: Day;
  summary: Summary;
  /** `ai_lines`. */
  maxLines: 1 | 2;
  /** The day was closed in an earlier visit: the stored summary is read, if there is one. */
  stored: boolean;
  /** Asks again (a retry, or after the consent was given from the button). */
  onAsk(): void;
}

function Reading({ day, maxLines }: { day: Day; maxLines: 1 | 2 }) {
  const reviews = useQuery('day/review', () =>
    api.GET('/v1/reviews', { params: { query: { kind: 'evening', limit: 1 } } }).then(unwrap),
  );
  const review = reviews.data?.items.find((r) => r.day === day);
  // A stored row may be older than task 18: its cards can be missing, and its words still show.
  const insight = review === undefined ? null : acceptInsight(review, maxLines, { cardsOptional: true });
  if (review === undefined) return null;
  if (insight === null) return <p class="ai-note">{UNAVAILABLE_TEXT}</p>;
  return <Shown insight={insight} maxLines={maxLines} day={day} />;
}

function Shown({ insight, maxLines, day }: { insight: GroundedInsight; maxLines: 1 | 2; day: Day }) {
  return (
    <InsightCard insight={insight} maxLines={maxLines} hideQuestion={insight.question !== null && insight.question !== ''}>
      {insight.question && <DeeperBlock day={day} question={insight.question} />}
    </InsightCard>
  );
}

/** The AI summary of the closed day (design 4, the evening): two lines with their sources and one
 *  question. When the AI cannot answer the day is closed all the same, and this says why in a line,
 *  with the way to try again. */
export function ClosureAi({ day, summary, maxLines, stored, onAsk }: ClosureAiProps) {
  let body;
  switch (summary.kind) {
    case 'none':
      body = stored ? <Reading day={day} maxLines={maxLines} /> : null;
      break;
    case 'loading':
      body = (
        <div class="state-frame" aria-busy="true">
          <span class="state-text" role="status">
            جارٍ التحليل
          </span>
          <Skeleton inlineSize="90%" />
          <Skeleton inlineSize="70%" />
        </div>
      );
      break;
    case 'ok':
      body = <Shown insight={summary.insight} maxLines={maxLines} day={day} />;
      break;
    case 'consent':
      body = <ConsentNotice onEnable={onAsk} />;
      break;
    case 'offline':
      body = (
        <div class="state-message">
          <p class="state-text">{OFFLINE_NOTE}</p>
          <Button onClick={onAsk}>إعادة المحاولة</Button>
        </div>
      );
      break;
    case 'error':
      body = (
        <div class="state-message" role="alert">
          <p class="state-text">{UNAVAILABLE_TEXT}</p>
          <Button onClick={onAsk}>إعادة المحاولة</Button>
        </div>
      );
      break;
  }
  if (body === null) return null;
  return (
    <section class="day-ai" aria-label="ملخص اليوم من الذكاء">
      {body}
    </section>
  );
}
