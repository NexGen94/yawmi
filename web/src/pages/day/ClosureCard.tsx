import type { ComponentChildren } from 'preact';

import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';

export interface ClosureCardProps {
  day: Day;
  closed: boolean;
  /** The AI summary of the closed day (task 20 fills it). */
  summary?: ComponentChildren;
}

/** The mark that the day was closed. It draws nothing before the closing. */
export function ClosureCard({ day, closed, summary }: ClosureCardProps) {
  if (!closed) return null;
  return (
    <section class="closure-card" aria-label="إغلاق اليوم">
      <p class="closure-title">أُغلق اليوم</p>
      <time class="closure-day" dateTime={day}>
        {fmt.day(day)}
      </time>
      {summary}
    </section>
  );
}
