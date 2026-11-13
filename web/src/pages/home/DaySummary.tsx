import { SourceCards } from '../../ai/SourceCards';
import type { components } from '../../api/schema';
import { openCountText } from '../../lib/counts';
import { focusScore, NO_TARGET, scoreLine } from '../../focus/today';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';

type JournalEntryOut = components['schemas']['JournalEntryOut'];

/** The two lines of the AI, with the number of sources they stand on and the cards of those
 *  sources. Always an estimate. */
export interface SummaryInsight {
  kicker: string;
  lines: string[];
  question: string | null;
  sourceCount: number;
  /** The cards of the sources and the days they come from (a row older than task 18 has none). */
  cards?: components['schemas']['SourceCard'][];
  days?: string[];
}

export interface DaySummaryProps {
  morning: JournalEntryOut | undefined;
  evening: JournalEntryOut | undefined;
  insight: SummaryInsight | null;
  /** The minutes of focus today and the target they are measured against (design 9.5). */
  focus?: { minutes: number; target: number | null };
}

interface Priority {
  title: string;
  state: 'done' | 'open' | 'moved';
}

const STATE_NOTE: Record<Priority['state'], string | null> = { open: null, done: 'منجزة', moved: 'منقولة إلى الغد' };

function titleOf(value: unknown): string | null {
  const title = (value as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() !== '' ? title : null;
}

/** The priorities of the morning, with the state the evening gave them (open until it says more). */
export function prioritiesOf(morning: JournalEntryOut | undefined, evening: JournalEntryOut | undefined): Priority[] {
  const planned = morning?.answers.priorities;
  if (!Array.isArray(planned)) return [];
  const closed = Array.isArray(evening?.answers.priorities) ? (evening?.answers.priorities as unknown[]) : [];
  const states = new Map<string, Priority['state']>();
  for (const entry of closed) {
    const title = titleOf(entry);
    const state = (entry as { state?: unknown }).state;
    if (title !== null && (state === 'done' || state === 'open' || state === 'moved')) states.set(title, state);
  }
  return planned.flatMap((entry) => {
    const title = titleOf(entry);
    return title === null ? [] : [{ title, state: states.get(title) ?? 'open' }];
  });
}

export { openCountText };

function sourcesText(n: number): string {
  if (n === 1) return 'استناداً إلى مصدر واحد';
  if (n === 2) return 'استناداً إلى مصدرين';
  return `استناداً إلى ${fmt.num(n)} مصادر`;
}

/** The focus line of the day: «50 · 45 من 90 دقيقة · للوعي الذاتي», or the minutes and what is
 *  missing when there is no target. Nothing at all when there is neither. */
function focusLine(focus: DaySummaryProps['focus']): string | null {
  if (focus === undefined || (focus.minutes <= 0 && focus.target === null)) return null;
  const score = focusScore(focus.minutes, focus.target);
  if (score !== null && focus.target !== null) return `درجة التركيز: ${scoreLine(score, focus.minutes, focus.target)}`;
  return `التركيز: ${fmt.count(focus.minutes, 'minute')} · ${NO_TARGET}`;
}

/** The works of the day: the three priorities of the morning, the focus score, and the AI's two
 *  lines with their sources. */
export function DaySummary({ morning, evening, insight, focus }: DaySummaryProps) {
  const focusText = focusLine(focus);
  const priorities = prioritiesOf(morning, evening);
  const open = priorities.filter((p) => p.state === 'open').length;
  return (
    <Card title="ملخص اليوم" class="day-summary">
      {priorities.length === 0 ? (
        <p class="summary-empty">لم تُحدَّد أولويات بعد</p>
      ) : (
        <>
          <ul class="summary-list">
            {priorities.map((p, i) => (
              <li key={`${i}-${p.title}`}>
                {p.title}
                {STATE_NOTE[p.state] && <span class="summary-note"> · {STATE_NOTE[p.state]}</span>}
              </li>
            ))}
          </ul>
          <p class="summary-open">{openCountText(open)}</p>
        </>
      )}
      {focusText && <p class="summary-line">{focusText}</p>}
      {insight && (
        <div class="summary-insight">
          <p class="summary-kicker">{insight.kicker} · تقدير</p>
          {insight.lines.slice(0, 2).map((line, i) => (
            <p key={`${i}-${line}`} class="summary-line">
              {line}
            </p>
          ))}
          {insight.question && <p class="summary-line">{insight.question}</p>}
          {insight.sourceCount > 0 && <p class="summary-note">{sourcesText(insight.sourceCount)}</p>}
          <SourceCards cards={insight.cards ?? []} days={insight.days ?? []} />
        </div>
      )}
    </Card>
  );
}
