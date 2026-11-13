/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import type { components } from '../api/schema';
import { Sparkline } from '../charts/Sparkline';
import { fmt } from '../lib/format';
import './insight.css';

type SourceCard = components['schemas']['SourceCard'];

export interface SourceCardsProps {
  /** The cards of the sources the reply cites, in the order of the citation. */
  cards: readonly SourceCard[];
  /** The days the cards come from, ascending: «من أيام: 9 نوفمبر، 10 نوفمبر». */
  days?: readonly string[];
}

/** The number a card gives: «4 من 7». A card without a number (a journal source) says its words. */
function cardValue(card: SourceCard): string | null {
  if (card.value === null) return null;
  return card.unit ? `${fmt.num(card.value)} ${card.unit}` : fmt.num(card.value);
}

/** The cards of the sources behind a reply (design 4, feature 26): what each one is, its number
 *  and its last seven days. A card the server did not give is simply not drawn. */
export function SourceCards({ cards, days = [] }: SourceCardsProps) {
  if (cards.length === 0 && days.length === 0) return null;
  return (
    <div class="ai-sources">
      {cards.length > 0 && (
        <ul class="ai-cards" aria-label="مصادر الجواب">
          {cards.map((card) => {
            const value = cardValue(card);
            const trend = (card.trend ?? []).map((v) => (v === null ? Number.NaN : v));
            return (
              <li key={card.source_id} class="ai-card">
                <span class="ai-card-label" dir="auto">
                  {card.label}
                </span>
                {value !== null ? (
                  <span class="ai-card-value">{value}</span>
                ) : (
                  <span class="ai-card-text" dir="auto">
                    {card.text}
                  </span>
                )}
                {trend.some((v) => Number.isFinite(v)) && <Sparkline values={trend} label={`آخر الأيام · ${card.label}`} />}
              </li>
            );
          })}
        </ul>
      )}
      {days.length > 0 && <p class="ai-days">{`من أيام: ${days.map((d) => fmt.dayShort(d)).join('، ')}`}</p>}
    </div>
  );
}
