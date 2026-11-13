import { useMemo, useState } from 'preact/hooks';

import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';
import { type JournalEntryOut, type MoodLogOut } from '../../data/pending';
import { useJournalData } from '../../review/data';
import { monthGroups } from '../../review/mood-stats';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { FEELINGS } from '../day/feelings';
import { LinkButton } from '../home/LinkButton';
import { MonthCard } from './MonthCard';

/** How many entries show at first, and how many more each press of «عرض المزيد» adds. */
export const PAGE_SIZE = 20;

const PART_LABEL = { morning: 'الصباح', evening: 'المساء' } as const;
const FEELING_LABEL = new Map(FEELINGS.map((f) => [f.code, f.label]));

/** A text field of the answers, or undefined when it is not a non-empty string. */
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => text(item) ?? []) : [];
}

function priorityTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => text((item as { title?: unknown } | null)?.title) ?? []);
}

interface Field {
  label: string;
  lines: string[];
}

/** The words of an entry, labelled, in the order the day page asks for them. Empty fields are left out. */
export function entryFields(entry: JournalEntryOut): Field[] {
  const a = entry.answers;
  const fields: Field[] = [];
  const add = (label: string, lines: string[]): void => {
    if (lines.length > 0) fields.push({ label, lines });
  };
  add('الأولويات', priorityTitles(a.priorities));
  const minutes = typeof a.planned_minutes === 'number' ? a.planned_minutes : null;
  if (minutes !== null) add('الدقائق المقررة', [fmt.count(minutes, 'minute')]);
  add('الحماس', textList([a.enthusiasm]));
  add('إنجاز اليوم', textList([a.win]));
  add('تعلّمت', textList([a.learned]));
  add('الامتنان', textList(a.gratitude));
  add('ملاحظة', textList([a.note]));
  return fields;
}

function moodOf(moods: ReadonlyMap<Day, MoodLogOut>, entry: JournalEntryOut, last: boolean): MoodLogOut | undefined {
  return last ? moods.get(entry.day) : undefined;
}

function Entry({ entry, mood }: { entry: JournalEntryOut; mood: MoodLogOut | undefined }) {
  const fields = entryFields(entry);
  return (
    <li class="review-entry">
      <article>
        <h3 class="review-entry-title">
          <span>{fmt.day(entry.day)}</span> <Badge>{PART_LABEL[entry.part]}</Badge>
        </h3>
        {mood !== undefined && (
          <div class="review-entry-mood">
            <p class="review-mood-score">{`المزاج: ${fmt.num(mood.score)} من ${fmt.num(5)}`}</p>
            {mood.feelings.length > 0 && (
              <ul class="review-feelings" aria-label="المشاعر">
                {mood.feelings.map((code) => (
                  <li key={code}>
                    <Badge>{FEELING_LABEL.get(code) ?? code}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {fields.length === 0 ? (
          <p class="review-none">بلا نص</p>
        ) : (
          <dl class="review-fields">
            {fields.map((f) => (
              <div key={f.label} class="review-field">
                <dt>{f.label}</dt>
                {f.lines.map((line, i) => (
                  <dd key={`${i}-${line}`}>{line}</dd>
                ))}
              </div>
            ))}
          </dl>
        )}
      </article>
    </li>
  );
}

/** Newest day first, and the evening before the morning of the same day. */
function newestFirst(a: JournalEntryOut, b: JournalEntryOut): number {
  if (a.day !== b.day) return a.day < b.day ? 1 : -1;
  return a.part === b.part ? 0 : a.part === 'evening' ? -1 : 1;
}

function TimelineSkeleton() {
  return (
    <div class="review-skeleton">
      <Skeleton blockSize="64px" />
      <Skeleton blockSize="120px" />
      <Skeleton blockSize="120px" />
    </div>
  );
}

/** The journal tab (feature 15): a card for each month, then the entries of the morning and of the
 *  evening, newest first, with the feelings of the day. Twenty at first. */
export function JournalTimeline({ today }: { today: Day }) {
  const data = useJournalData(today);
  const [shown, setShown] = useState(PAGE_SIZE);
  const entries = useMemo(() => [...data.journal].sort(newestFirst), [data.journal]);
  const months = useMemo(() => monthGroups(data.journal, data.mood), [data.journal, data.mood]);
  const moods = useMemo(() => new Map(data.mood.map((m) => [m.day, m])), [data.mood]);
  const visible = entries.slice(0, shown);

  return (
    <StateFrame
      state={data.query.state}
      stale={data.query.stale}
      empty={data.journal.length === 0 && data.mood.length === 0}
      emptyText="لا إدخالات بعد"
      emptyAction={<LinkButton href="/day/morning">بدء يومية الصباح</LinkButton>}
      onRetry={data.query.reload}
      skeleton={<TimelineSkeleton />}
    >
      <div class="review-timeline">
        <ul class="review-months" aria-label="ملخص الأشهر">
          {months.map((group) => (
            <li key={group.month}>
              <MonthCard group={group} />
            </li>
          ))}
        </ul>
        <ol class="review-entries" aria-label="إدخالات اليوميات">
          {visible.map((entry, i) => {
            // the mood of a day sits with the last part of that day that was written
            const lastOfDay = visible.findIndex((e) => e.day === entry.day) === i;
            return <Entry key={`${entry.day}:${entry.part}`} entry={entry} mood={moodOf(moods, entry, lastOfDay)} />;
          })}
        </ol>
        {entries.length > shown && (
          <div class="review-more">
            <Button onClick={() => setShown(shown + PAGE_SIZE)}>عرض المزيد</Button>
          </div>
        )}
      </div>
    </StateFrame>
  );
}
