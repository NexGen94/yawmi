import type { components } from '../../api/schema';
import { openCountText } from '../../lib/counts';
import { fmt } from '../../lib/format';
import { Card } from '../../ui/Card';

type JournalEntryOut = components['schemas']['JournalEntryOut'];

/** The two lines of the AI, with the number of sources they stand on (the source cards come with
 *  the ask page). Always an estimate. */
export interface SummaryInsight {
  kicker: string;
  lines: string[];
  question: string | null;
  sourceCount: number;
}

export interface DaySummaryProps {
  morning: JournalEntryOut | undefined;
  evening: JournalEntryOut | undefined;
  insight: SummaryInsight | null;
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

/** The works of the day: the three priorities of the morning, and the AI's two lines with their
 *  sources. The focus score joins them with the focus page. */
export function DaySummary({ morning, evening, insight }: DaySummaryProps) {
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
        </div>
      )}
    </Card>
  );
}
