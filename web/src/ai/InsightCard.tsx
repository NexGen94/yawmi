/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import type { ComponentChildren } from 'preact';

import './ai.css';
import type { GroundedInsight } from './guard';
import { SourceCards } from './SourceCards';

export interface InsightCardProps {
  insight: GroundedInsight;
  /** `ai_lines`: the most lines the person asked for. */
  maxLines: 1 | 2;
  /** Under the lines and the question (a «go deeper» button, «حفظ في الذاكرة»). */
  children?: ComponentChildren;
  /** The question is drawn by the caller (DeeperChips shows it with its alternatives). */
  hideQuestion?: boolean;
}

/** A reply of the AI: its lines (at most `maxLines`), one question, and the cards of its sources
 *  with their days. Always an estimate. Only a reply that passed `acceptInsight` belongs here. */
export function InsightCard({ insight, maxLines, children, hideQuestion }: InsightCardProps) {
  return (
    <div class="ai-insight">
      <p class="ai-kicker">تقدير</p>
      {insight.lines.slice(0, maxLines).map((line, i) => (
        <p key={`${i}-${line}`} class="ai-line">
          {line}
        </p>
      ))}
      {!hideQuestion && insight.question && <p class="ai-question">{insight.question}</p>}
      <SourceCards cards={insight.cards ?? []} days={insight.days ?? []} />
      {children}
    </div>
  );
}
