import type { components } from '../../api/schema';
import type { DayHabit } from './useDayData';

type SourceCard = components['schemas']['SourceCard'];

export interface SourceLabel {
  /** The kind, in Arabic («هدف»). */
  kind: string;
  /** The reference or the habit's title. */
  ref: string;
}

const KINDS: Readonly<Record<string, string>> = { goal: 'هدف', milestone: 'محطة', habit: 'عادة' };

/** A suggestion's source as a person reads it: «هدف O5», «محطة m12», «عادة القراءة». The ids of the
 *  insight are internal codes, so one that cannot be named (an unknown kind, or a habit that is not
 *  in today's list) is not shown at all. Task 18's `SourceCard.label` can replace this. */
export function sourceLabel(sourceId: string, habits: readonly DayHabit[]): SourceLabel | null {
  const at = sourceId.indexOf(':');
  if (at <= 0) return null;
  const prefix = sourceId.slice(0, at);
  const ref = sourceId.slice(at + 1);
  const kind = KINDS[prefix];
  if (kind === undefined || ref === '') return null;
  if (prefix === 'habit') {
    const habit = habits.find((h) => h.code === ref);
    return habit ? { kind, ref: habit.title } : null;
  }
  return { kind, ref };
}

const CARD_KINDS: Readonly<Record<string, string>> = { habit: 'عادة', milestone: 'محطة', outcome: 'هدف' };

/** The name of a source from the card the server gave for it, when there is one for that source
 *  (a stored row older than task 18 has none: `sourceLabel` then names it from its id). */
export function cardLabel(sourceId: string, cards: readonly SourceCard[]): SourceLabel | null {
  const card = cards.find((c) => c.source_id === sourceId);
  const kind = card === undefined ? undefined : CARD_KINDS[card.kind];
  return card === undefined || kind === undefined || card.label === '' ? null : { kind, ref: card.label };
}
