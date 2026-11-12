/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite's client types itself)

import { useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';

import { fmt } from '../../lib/format';
import { todayRiyadh } from '../../lib/today';
import { Segmented } from '../../ui/Segmented';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { ContextColumn } from './ContextColumn';
import './day.css';
import { pruneOldDrafts } from './draft';
import { EveningForm } from './EveningForm';
import { MorningForm } from './MorningForm';
import { type DayPart, defaultPart } from './part';
import { useSaveStatus } from './SaveStatus';
import { useDayData } from './useDayData';

const PARTS: readonly { value: DayPart; label: string }[] = [
  { value: 'morning', label: 'الصباح' },
  { value: 'evening', label: 'المساء' },
];

/** `/day/morning` and `/day/evening` are one page: the switch, the form of the side, and the
 *  context column. `/day` itself goes to the side the hour asks for (design section 3). */
export default function DayPage() {
  const { path, route } = useLocation();
  const part: DayPart | null = path.endsWith('/evening') ? 'evening' : path.endsWith('/morning') ? 'morning' : null;

  useEffect(() => {
    if (part === null) route(`/day/${defaultPart()}`, true);
  }, [part, route]);

  const data = useDayData();
  const status = useSaveStatus(data.pending, data.refreshPending);

  // Drafts are private text: those of days before yesterday go when the page loads, and again at midnight.
  useEffect(() => pruneOldDrafts(data.day), [data.day]);

  if (part === null) return <h1>اليوم</h1>;

  const { day, entries } = data;
  const morning = entries.find((e) => e.day === day && e.part === 'morning');
  const evening = entries.find((e) => e.day === day && e.part === 'evening');
  const waiting = data.pending.some(
    (e) =>
      e.type === 'journal_saved' &&
      (e.payload as { part?: string }).part === 'evening' &&
      ((e.payload as { day?: string | null }).day ?? todayRiyadh(new Date(e.occurred_at))) === day,
  );

  const skeleton = (
    <div class="day-skeleton">
      <Skeleton blockSize="var(--fs-num)" inlineSize="40%" />
      <Skeleton blockSize="120px" />
      <Skeleton blockSize="120px" />
      <Skeleton blockSize="200px" />
    </div>
  );

  return (
    <div class="day-page">
      <h1>اليوم</h1>
      <div class="day-head">
        <p class="day-date">
          {fmt.day(day)} · <span dir="auto">{fmt.hijri(day)}</span>
        </p>
        <Segmented label="الفترة" options={PARTS} value={part} onChange={(next) => route(`/day/${next}`)} />
      </div>
      <div class="page-cols">
        <div class="day-main">
          <StateFrame state={data.state} stale={data.stale} emptyText="" onRetry={data.reload} skeleton={skeleton}>
            {part === 'morning' ? (
              <MorningForm
                key={`${day}-morning`}
                day={day}
                entry={morning}
                insight={data.today?.insight ?? null}
                onSaved={status.onSaved}
              />
            ) : (
              <EveningForm
                key={`${day}-evening`}
                day={day}
                morning={morning}
                evening={evening}
                entries={entries}
                mood={data.mood}
                habits={data.habits}
                doneCodes={data.doneCodes}
                closure={{ closed: evening !== undefined, waiting, offline: data.offline }}
                onSaved={status.onSaved}
              />
            )}
          </StateFrame>
          {status.node}
        </div>
        {data.today && <ContextColumn plan={data.today.plan} />}
      </div>
    </div>
  );
}
