import { useRef, useState } from 'preact/hooks';

import { ConsentNotice } from '../../ai/ConsentDialog';
import { acceptInsight, type GroundedInsight, UNAVAILABLE_TEXT } from '../../ai/guard';
import { InsightCard } from '../../ai/InsightCard';
import { type AiResult, unwrapAi, useAi } from '../../ai/useAi';
import { api } from '../../api/client';
import type { Day } from '../../domain/types';
import { OFFLINE_NOTE } from '../../lib/notes';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; insight: GroundedInsight }
  | { kind: 'consent' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string };

export interface WeeklyInsightProps {
  /** The Riyadh day: the server keys the week by the first day of the week that holds it. */
  today: Day;
  /** The review already stored for this week, shown before anything is asked. */
  stored: GroundedInsight | undefined;
  /** `ai_lines`. */
  maxLines: 1 | 2;
}

/** The AI paragraph of the week (feature 21): the recurring theme in at most two lines, with the cards
 *  of its sources and their days. The page never asks by itself: one press is one request to
 *  `POST /v1/insights/weekly`, through the same consent flow as every AI screen. A fixed line (out of
 *  scope, no data) is a plain reply. */
export function WeeklyInsight({ today, stored, maxLines }: WeeklyInsightProps) {
  const ai = useAi();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const turn = useRef(0);
  const linesNow = useRef(maxLines);
  linesNow.current = maxLines;

  const settle = (result: AiResult<GroundedInsight>): Phase => {
    switch (result.kind) {
      case 'ok': {
        const accepted = acceptInsight(result.value, linesNow.current);
        return accepted === null ? { kind: 'error', message: UNAVAILABLE_TEXT } : { kind: 'ok', insight: accepted };
      }
      case 'consent_required':
        return { kind: 'consent' };
      case 'offline':
        return { kind: 'offline' };
      default:
        return { kind: 'error', message: result.message };
    }
  };

  const generate = async (): Promise<void> => {
    const mine = ++turn.current;
    setPhase({ kind: 'loading' });
    const result = await ai.run(() =>
      api.POST('/v1/insights/weekly', { body: { day: today, regenerate: false } }).then(unwrapAi),
    );
    if (mine === turn.current) setPhase(settle(result));
  };

  const loading = phase.kind === 'loading';
  const storedInsight = stored === undefined ? null : acceptInsight(stored, maxLines, { cardsOptional: true });
  let body;
  switch (phase.kind) {
    case 'idle':
      body =
        storedInsight !== null && storedInsight.lines.length > 0 ? (
          <InsightCard insight={storedInsight} maxLines={maxLines} />
        ) : (
          <p class="review-none">{stored !== undefined && storedInsight === null ? UNAVAILABLE_TEXT : 'لم تُولَّد مراجعة لهذا الأسبوع بعد'}</p>
        );
      break;
    case 'loading':
      body = (
        <>
          <output class="state-text">جارٍ التحليل</output>
          <Skeleton inlineSize="90%" />
          <Skeleton inlineSize="70%" />
        </>
      );
      break;
    case 'ok':
      body = <InsightCard insight={phase.insight} maxLines={maxLines} />;
      break;
    case 'consent':
      body = <ConsentNotice onEnable={() => void generate()} />;
      break;
    case 'offline':
      body = (
        <div class="state-message">
          <p class="state-text">{OFFLINE_NOTE}</p>
          <Button onClick={() => void generate()}>إعادة المحاولة</Button>
        </div>
      );
      break;
    case 'error':
      body = (
        <div class="state-message" role="alert">
          <p class="state-text">{phase.message}</p>
          <Button onClick={() => void generate()}>إعادة المحاولة</Button>
        </div>
      );
      break;
  }

  return (
    <Card title="مراجعة الأسبوع">
      <div class="review-insight" aria-busy={loading ? 'true' : 'false'}>
        {body}
        <div class="review-actions">
          <Button variant="primary" disabled={loading} onClick={() => void generate()}>
            توليد مراجعة الأسبوع
          </Button>
        </div>
      </div>
      {ai.dialog}
    </Card>
  );
}
