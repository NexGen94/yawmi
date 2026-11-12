import type { DayHabit } from './useDayData';

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
