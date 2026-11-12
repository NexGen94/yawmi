import type { JournalEntryOut } from '../../data/pending';
import type { Day } from '../../domain/types';
import { addDays } from './part';

export interface OnThisDayProps {
  day: Day;
  /** The journal of the last 30 days (and today). */
  entries: readonly JournalEntryOut[];
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** What was written on that day: the win, else what was learned, word for word. */
function lookBack(entries: readonly JournalEntryOut[], day: Day): string | undefined {
  const that = entries.filter((e) => e.day === day);
  const win = that.map((e) => text(e.answers.win)).find((t) => t !== undefined);
  return win ?? that.map((e) => text(e.answers.learned)).find((t) => t !== undefined);
}

/** «في مثل هذا اليوم» (feature 17): at most two lines, a week ago and a month ago. A line with
 *  nothing behind it is not drawn, and with neither line the section is not drawn either. */
export function OnThisDay({ day, entries }: OnThisDayProps) {
  const lines = [
    { label: 'قبل أسبوع:', text: lookBack(entries, addDays(day, -7)) },
    { label: 'قبل شهر:', text: lookBack(entries, addDays(day, -30)) },
  ].filter((l): l is { label: string; text: string } => l.text !== undefined);
  if (lines.length === 0) return null;
  return (
    <section class="on-this-day" aria-labelledby="on-this-day-title">
      <h3 id="on-this-day-title" class="day-h">
        في مثل هذا اليوم
      </h3>
      <ul class="otd-list">
        {lines.map((l) => (
          <li key={l.label}>
            <span class="otd-label">{l.label}</span>{' '}
            <span class="otd-text" dir="auto">
              {l.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
