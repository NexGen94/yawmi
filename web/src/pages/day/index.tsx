/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite's client types itself)

import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';
import { useSettings } from '../../settings/data';
import { todayRiyadh } from '../../lib/today';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Segmented } from '../../ui/Segmented';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { ContextColumn } from './ContextColumn';
import './day.css';
import { discardDraft, hasUnsavedDraft, pruneOldDrafts, reconcileDrafts } from './draft';
import { EveningForm } from './EveningForm';
import { MorningForm } from './MorningForm';
import { addDays, type DayPart, defaultPart } from './part';
import { type SaveRecord, useSaveStatus } from './SaveStatus';
import { type DayHabit, useDayData } from './useDayData';

const PARTS: readonly { value: DayPart; label: string }[] = [
  { value: 'morning', label: 'الصباح' },
  { value: 'evening', label: 'المساء' },
];
const PART_LABEL: Readonly<Record<DayPart, string>> = { morning: 'الصباح', evening: 'المساء' };

/** What the live day showed the last time it was ready, kept for the moment the day turns over
 *  while a form still holds unsaved words: that form stays on its own day and needs its habits. */
interface Snapshot {
  habits: DayHabit[];
  habitsKnown: boolean;
  doneCodes: string[];
}

/** The words of yesterday that no event holds yet, one entry per side. */
function unsavedOfYesterday(today: Day, refusedIds: ReadonlySet<string>): { day: Day; part: DayPart }[] {
  const day = addDays(today, -1);
  return PARTS.map((p) => p.value).flatMap((part) => (hasUnsavedDraft(day, part, refusedIds) ? [{ day, part }] : []));
}

function partOf(path: string): DayPart | null {
  if (path.endsWith('/evening')) return 'evening';
  return path.endsWith('/morning') ? 'morning' : null;
}

/** `/day/morning` and `/day/evening` are one page: the switch, the form of the side, and the
 *  context column. `/day` itself goes to the side the hour asks for (design section 3). */
export default function DayPage() {
  const { path, route } = useLocation();
  const part = partOf(path);

  useEffect(() => {
    if (part === null) route(`/day/${defaultPart()}`, true);
  }, [part, route]);

  const data = useDayData();
  // The AI parts follow the settings of the person; until they are read the defaults of the server stand.
  const settings = useSettings();
  const aiLines = settings.data?.ai_lines ?? 2;
  const aiCheckin = settings.data?.ai_checkin ?? 'evening';

  // At Riyadh midnight the page moves to the new day, unless the open side holds words that were
  // not saved: then it stays on the day that ended until they are saved there or the person moves on.
  const [held, setHeld] = useState<Day | null>(null);
  const [seenDay, setSeenDay] = useState(data.day);
  const refusedIds = new Set(data.quarantine.map((e) => e.id));
  if (seenDay !== data.day) {
    setSeenDay(data.day);
    if (held === null && part !== null && hasUnsavedDraft(seenDay, part, refusedIds)) setHeld(seenDay);
  }
  const viewDay = held ?? data.day;
  const live = viewDay === data.day;
  const [, setTick] = useState(0); // a draft changed outside React's sight: draw the notices again

  const status = useSaveStatus({
    pending: data.pending,
    quarantine: data.quarantine,
    refreshPending: data.refreshPending,
    part: part ?? 'morning',
    viewDay,
    today: data.day,
  });
  const onSaved = async (record: SaveRecord): Promise<void> => {
    await status.onSaved(record);
    if (held !== null && record.day === held) setHeld(null); // saved for its own day: on to today
    setTick((n) => n + 1);
  };
  const saveRef = useRef<(() => Promise<void>) | null>(null);

  const snapshot = useRef<Snapshot | null>(null);
  useEffect(() => {
    if (held === null && data.habitsKnown) {
      snapshot.current = { habits: data.habits, habitsKnown: true, doneCodes: data.doneCodes };
    }
  });

  // Drafts of days before yesterday go (the held day stays), and those the server accepted go.
  useEffect(() => pruneOldDrafts(data.day, held === null ? [] : [held]), [data.day, held]);
  useEffect(() => {
    if (data.queueEpoch === 0) return;
    reconcileDrafts(
      [data.day, addDays(data.day, -1), ...(held === null ? [] : [held])],
      new Set(data.pending.map((e) => e.id)),
      new Set(data.quarantine.map((e) => e.id)),
      data.queueEpoch,
    );
    setTick((n) => n + 1);
  }, [data.queueEpoch, data.pending, data.quarantine, data.day, held]);

  if (part === null) return <h1>اليوم</h1>;

  const { entries } = data;
  const morning = entries.find((e) => e.day === viewDay && e.part === 'morning');
  const evening = entries.find((e) => e.day === viewDay && e.part === 'evening');
  const waiting = data.pending.some(
    (e) =>
      e.type === 'journal_saved' &&
      (e.payload as { part?: string }).part === 'evening' &&
      ((e.payload as { day?: string | null }).day ?? todayRiyadh(new Date(e.occurred_at))) === viewDay,
  );
  const habits = live ? data.habits : (snapshot.current?.habits ?? []);
  const habitsKnown = live ? data.habitsKnown : (snapshot.current?.habitsKnown ?? false);
  const doneCodes = live ? data.doneCodes : (snapshot.current?.doneCodes ?? []);
  // Yesterday's unsaved words wait on the new day too, to be opened or thrown away on purpose.
  const past = held === null ? unsavedOfYesterday(data.day, refusedIds) : [];
  const noCopy = data.state === 'offline' && !data.stale;

  const skeleton = (
    <div class="day-skeleton">
      <Skeleton blockSize="var(--fs-num)" inlineSize="40%" />
      <Skeleton blockSize="120px" />
      <Skeleton blockSize="120px" />
      <Skeleton blockSize="200px" />
    </div>
  );

  const form =
    part === 'morning' ? (
      <MorningForm
        key={`${viewDay}-morning`}
        day={viewDay}
        entry={morning}
        insight={live ? (data.today?.insight ?? null) : null}
        aiLines={aiLines}
        aiCheckin={aiCheckin}
        autoSuggest={live && data.today !== undefined && !data.today.insight}
        habits={habits}
        onSaved={onSaved}
        saveRef={saveRef}
      />
    ) : (
      <EveningForm
        key={`${viewDay}-evening`}
        day={viewDay}
        morning={morning}
        evening={evening}
        entries={entries}
        mood={live ? data.mood : undefined}
        habits={habits}
        habitsKnown={habitsKnown}
        doneCodes={doneCodes}
        closure={{ closed: evening !== undefined, waiting, offline: data.offline }}
        aiLines={aiLines}
        aiCheckin={aiCheckin}
        pending={data.pending}
        quarantine={data.quarantine}
        onSaved={onSaved}
        saveRef={saveRef}
      />
    );

  let body: ComponentChildren;
  if (held !== null) {
    // The form is shown whatever the new day's queries are doing: it holds the person's words.
    body = <div class="state-frame">{form}</div>;
  } else if (noCopy) {
    // Offline and nothing was ever saved: logging still works through the queue.
    body = (
      <div class="state-frame">
        <div class="state-stale">
          <Badge>بلا اتصال</Badge>
        </div>
        <p class="day-note day-offline-note">لا نسخة محفوظة بعد · التسجيل يعمل ويُرسل عند عودة الاتصال</p>
        {form}
      </div>
    );
  } else {
    body = (
      <StateFrame state={data.state} stale={data.stale} emptyText="" onRetry={data.reload} skeleton={skeleton}>
        {form}
      </StateFrame>
    );
  }

  return (
    <div class="day-page">
      <h1>اليوم</h1>
      <div class="day-head">
        <p class="day-date">
          {fmt.day(viewDay)} · <span dir="auto">{fmt.hijri(viewDay)}</span>
        </p>
        <Segmented label="الفترة" options={PARTS} value={part} onChange={(next) => route(`/day/${next}`)} />
      </div>
      <div class="page-cols">
        <div class="day-main">
          {held !== null && (
            <section class="day-notice" aria-label="نص يوم أمس">
              <p class="day-notice-text">نص يوم أمس لم يُحفظ بعد</p>
              <div class="day-notice-actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    // The words may have been cleared since: then there is nothing to save for that day.
                    if (hasUnsavedDraft(held, part, refusedIds)) void saveRef.current?.();
                    else setHeld(null);
                  }}
                >
                  حفظه ليوم أمس
                </Button>
                <Button onClick={() => setHeld(null)}>الانتقال إلى اليوم</Button>
              </div>
            </section>
          )}
          {past.map((p) => (
            <section key={`${p.day}-${p.part}`} class="day-notice" aria-label={`نص يوم أمس · ${PART_LABEL[p.part]}`}>
              <p class="day-notice-text">
                نص يوم أمس لم يُحفظ بعد <span class="day-note">({PART_LABEL[p.part]})</span>
              </p>
              <div class="day-notice-actions">
                <Button
                  onClick={() => {
                    setHeld(p.day);
                    if (p.part !== part) route(`/day/${p.part}`);
                  }}
                >
                  فتحه
                </Button>
                <Button
                  onClick={() => {
                    discardDraft(p.day, p.part);
                    setTick((n) => n + 1);
                  }}
                >
                  حذفه
                </Button>
              </div>
            </section>
          ))}
          {body}
          {status.node}
        </div>
        {live && data.today && <ContextColumn plan={data.today.plan} />}
      </div>
    </div>
  );
}
