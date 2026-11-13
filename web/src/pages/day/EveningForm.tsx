import { useEffect, useId, useRef, useState } from 'preact/hooks';

import { acceptInsight } from '../../ai/guard';
import { type AiResult, unwrapAi, useAi } from '../../ai/useAi';
import { api } from '../../api/client';
import type { components } from '../../api/schema';
import { logMood, saveJournal } from '../../data/events';
import type { JournalEntryOut, MoodLogOut } from '../../data/pending';
import type { OutboxEvent, QuarantinedEvent } from '../../sync/outbox';
import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { CheckRow } from '../../ui/CheckRow';
import { Field } from '../../ui/Field';
import { Slider } from '../../ui/Slider';
import { Switch } from '../../ui/Switch';
import { ActivityChips } from './ActivityChips';
import { ClosureAi, type Summary } from './ClosureAi';
import { ClosureCard } from './ClosureCard';
import { clearSaved, markSaved, readDraft, writeDraft } from './draft';
import { FeelingChips } from './FeelingChips';
import { GratitudeFields } from './GratitudeFields';
import { LIMITS } from './limits';
import { MoodScale } from './MoodScale';
import { OnThisDay } from './OnThisDay';
import { type SaveRecord, saveOutcome } from './SaveStatus';
import type { DayHabit } from './useDayData';

type EveningAnswers = components['schemas']['EveningAnswers'];
type PriorityState = 'done' | 'open' | 'moved';

interface EveningPriority {
  title: string;
  state: PriorityState;
}

interface EveningState {
  oneMinute: boolean;
  score: number | null;
  feelings: string[];
  /** null until the person changes it: then the activities are the habits done today. */
  activities: string[] | null;
  priorities: EveningPriority[];
  calm: number | null;
  distraction: number | null;
  presence: number | null;
  win: string;
  winOutcome: string;
  learned: string;
  gratitude: string[];
  note: string;
}

const OUTCOMES = Array.from({ length: 12 }, (_, i) => `O${i + 1}`);
const STATES: readonly string[] = ['done', 'open', 'moved'];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const score = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function prioritiesOf(answers: JournalEntryOut['answers'] | undefined): EveningPriority[] {
  const list = Array.isArray(answers?.priorities) ? (answers.priorities as Record<string, unknown>[]) : [];
  return list.flatMap((p) => {
    const title = str(p.title);
    const state = STATES.includes(str(p.state)) ? (p.state as PriorityState) : 'open';
    return title === '' ? [] : [{ title, state }];
  });
}

/** The morning's priorities, each with the state it had in the evening so far (a draft first, then
 *  the saved evening); a priority nobody touched is open. Without a morning the saved evening's own
 *  list stands. */
function mergePriorities(
  morning: JournalEntryOut | undefined,
  evening: JournalEntryOut | undefined,
  draft: EveningPriority[] | undefined,
): EveningPriority[] {
  const earlier = new Map<string, PriorityState>();
  for (const p of prioritiesOf(evening?.answers)) earlier.set(p.title, p.state);
  for (const p of draft ?? []) earlier.set(p.title, p.state);
  const base = morning ? prioritiesOf(morning.answers) : prioritiesOf(evening?.answers);
  return base.map((p) => ({ title: p.title, state: earlier.get(p.title) ?? 'open' }));
}

const sorted = (a: readonly string[]): string[] => [...a].sort((x, y) => x.localeCompare(y));
const signature = (score: number | null, feelings: readonly string[], activities: readonly string[]): string =>
  JSON.stringify([score, sorted(feelings), sorted(activities)]);

function fromEntry(
  entry: JournalEntryOut | undefined,
  morning: JournalEntryOut | undefined,
  mood: MoodLogOut | undefined,
  draft: EveningState | undefined,
): EveningState {
  const a = entry?.answers;
  const gratitude = Array.isArray(a?.gratitude) ? a.gratitude.map(str) : [];
  return {
    oneMinute: a?.one_minute === true,
    score: mood?.score ?? null,
    feelings: mood?.feelings ?? [],
    activities: mood ? mood.activities : null,
    priorities: mergePriorities(morning, entry, draft?.priorities),
    calm: score(a?.calm),
    distraction: score(a?.distraction),
    presence: score(a?.presence),
    win: str(a?.win),
    winOutcome: str(a?.win_outcome),
    learned: str(a?.learned),
    gratitude: [0, 1, 2].map((i) => gratitude[i] ?? ''),
    note: str(a?.note),
  };
}

function isState(value: unknown): value is EveningState {
  const s = value as Partial<EveningState> | undefined;
  return Array.isArray(s?.priorities) && Array.isArray(s.feelings) && Array.isArray(s.gratitude) && typeof s.note === 'string';
}

/** Where the day's closing stands, for the line above the form. */
export interface Closure {
  /** The evening journal exists (saved or queued). */
  closed: boolean;
  /** It is queued and has not reached the server. */
  waiting: boolean;
  /** There is no connection, so «waiting» means until it returns. */
  offline: boolean;
}

export interface EveningFormProps {
  day: Day;
  morning: JournalEntryOut | undefined;
  /** The saved (or queued) evening of this day, if any. */
  evening: JournalEntryOut | undefined;
  /** The journal of the last 30 days, for «في مثل هذا اليوم». */
  entries: readonly JournalEntryOut[];
  mood: MoodLogOut | undefined;
  habits: readonly DayHabit[];
  /** The list of habits is known (from the server or a saved copy). */
  habitsKnown: boolean;
  doneCodes: readonly string[];
  closure: Closure;
  /** `ai_lines` (2 until the settings are read). */
  aiLines?: 1 | 2;
  /** `ai_checkin`: with `morning` the AI summary belongs to the morning, and closing asks for none. */
  aiCheckin?: 'morning' | 'evening';
  /** The queue as the page reads it: the summary is asked for once the closing has left it. */
  pending?: readonly OutboxEvent[];
  quarantine?: readonly QuarantinedEvent[];
  onSaved(record: SaveRecord): Promise<void>;
  /** The page can close this form too (the notice about yesterday's text does). */
  saveRef?: { current: (() => Promise<void>) | null };
}

function Score(props: { label: string; value: number | null; onChange(v: number): void }) {
  const { label, value, onChange } = props;
  return (
    <div class="day-score" data-unset={value === null ? 'true' : undefined}>
      <Slider
        label={label}
        min={1}
        max={10}
        value={value ?? 5}
        unset={value === null}
        onChange={onChange}
        valueText={(v) => `${fmt.num(v)} من ${fmt.num(10)}`}
      />
      {value === null && <p class="day-note">لم يُحدَّد، ولن يُسجَّل</p>}
    </div>
  );
}

/** The evening card: the mood in a tap or two, the morning's priorities, three sliders, the win,
 *  what was learned, gratitude and the free text. «دقيقة واحدة» keeps only the quick part. Closing
 *  queues one `journal_saved` (and the mood too if it was chosen and not logged yet). */
export function EveningForm(props: EveningFormProps) {
  const { day, morning, evening, entries, mood, habits, habitsKnown, doneCodes, closure, onSaved, saveRef } = props;
  const aiLines = props.aiLines ?? 2;
  const aiCheckin = props.aiCheckin ?? 'evening';
  const draft = readDraft<EveningState>(day, 'evening');
  const [state, setState] = useState<EveningState>(() => {
    const restored = isState(draft) ? draft : undefined;
    const base = fromEntry(evening, morning, mood, restored);
    return restored ? { ...restored, priorities: base.priorities } : base;
  });
  const [logged, setLogged] = useState<string | null>(() => (mood ? signature(mood.score, mood.feelings, mood.activities) : null));
  const [busy, setBusy] = useState(false);
  const touched = useRef(isState(draft));
  const saving = useRef(false);
  const latest = useRef(state);
  latest.current = state;
  const outcomeId = useId();
  const ai = useAi();
  const [summary, setSummary] = useState<Summary>({ kind: 'none' });
  const linesNow = useRef(aiLines);
  linesNow.current = aiLines;
  const turn = useRef(0);
  /** The ids of the closing while its events wait in the queue (the window of «تراجع», then the send). */
  const [waitingIds, setWaitingIds] = useState<string[] | null>(null);
  /** A closed day shows what was written as a summary; «تعديل الإغلاق» opens the form again. */
  const [reopened, setReopened] = useState(false);
  const folded = (closure.closed || closure.waiting) && !reopened;

  /** The AI summary of the day just closed. It is asked for only after the server has accepted the
   *  closing (so it is built from what was written) and never if the closing was taken back. A failure
   *  of any kind leaves the day closed and says «تعذّر التحليل اليوم» (the guard refusing a reply counts). */
  const askSummary = async (prompt: boolean): Promise<void> => {
    const mine = ++turn.current;
    setSummary({ kind: 'loading' });
    const result: AiResult<components['schemas']['InsightOut']> = await ai.run(
      () => api.POST('/v1/day/close', { body: { day, regenerate: false } }).then(unwrapAi),
      { prompt },
    );
    if (mine !== turn.current) return;
    if (result.kind === 'ok') {
      const accepted = acceptInsight(result.value, linesNow.current);
      setSummary(accepted === null ? { kind: 'error' } : { kind: 'ok', insight: accepted });
    } else if (result.kind === 'consent_required') setSummary({ kind: 'consent' });
    else if (result.kind === 'offline') setSummary({ kind: 'offline' });
    else setSummary({ kind: 'error' });
  };

  // The closing waits in the queue for its window and then goes out. When the server has accepted
  // every event of it, the summary is asked for; a refusal ends the wait; an undo clears it first.
  useEffect(() => {
    if (waitingIds === null) return;
    if (props.pending === undefined) {
      setWaitingIds(null);
      void askSummary(false);
      return;
    }
    const outcome = saveOutcome(
      waitingIds,
      new Set(props.pending.map((e) => e.id)),
      new Set((props.quarantine ?? []).map((e) => e.id)),
    );
    if (outcome === 'accepted') {
      setWaitingIds(null);
      void askSummary(false);
    } else if (outcome === 'refused') {
      setWaitingIds(null);
      setSummary({ kind: 'none' });
    }
    // askSummary only reads refs and the day
      }, [waitingIds, props.pending, props.quarantine]);

  useEffect(() => {
    if (touched.current) writeDraft(day, 'evening', state);
  }, [day, state]);

  const update = (patch: Partial<EveningState>): void => {
    touched.current = true;
    // Words changed after a save: they are not what the queue holds.
    clearSaved(day, 'evening');
    setState((s) => ({ ...s, ...patch }));
  };
  const setPriority = (i: number, next: PriorityState): void =>
    update({ priorities: state.priorities.map((p, j) => (j === i ? { ...p, state: next } : p)) });

  const activities = (state.activities ?? [...doneCodes]).slice(0, LIMITS.activities);
  const moodSignature = state.score === null ? null : signature(state.score, state.feelings, activities);
  const moodDirty = moodSignature !== null && moodSignature !== logged;

  /** Queues the mood when there is a new one; returns its event id. */
  const queueMood = async (): Promise<string | null> => {
    if (state.score === null || !moodDirty) return null;
    const id = await logMood({ day, score: state.score, feelings: state.feelings, activities });
    setLogged(moodSignature);
    return id;
  };

  /** Runs one save at a time: a second click while the first is on its way does nothing. */
  const once = async (work: () => Promise<void>): Promise<void> => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const saveMood = (): Promise<void> =>
    once(async () => {
      const before = logged;
      const id = await queueMood();
      if (id === null) return;
      await onSaved({
        ids: [id],
        day,
        part: 'evening',
        onUndone: () => setLogged(before),
        onRefused: () => setLogged(before),
      });
    });

  const close = (): Promise<void> =>
    once(async () => {
      const before = logged;
      const one = state.oneMinute;
      const answers: EveningAnswers = {
        one_minute: one,
        priorities: state.priorities,
        calm: one ? null : state.calm,
        distraction: one ? null : state.distraction,
        presence: one ? null : state.presence,
        win: state.win.trim() || null,
        win_outcome: (state.winOutcome || null) as EveningAnswers['win_outcome'],
        learned: one ? null : state.learned.trim() || null,
        gratitude: state.gratitude.map((g) => g.trim()).filter((g) => g !== ''),
        note: state.note.trim() || null,
      };
      const ids: string[] = [];
      const moodId = await queueMood();
      if (moodId !== null) ids.push(moodId);
      const journalId = await saveJournal('evening', answers, day);
      ids.push(journalId);
      // The draft stays until the server has accepted the events (reconcileDrafts).
      writeDraft(day, 'evening', latest.current);
      markSaved(day, 'evening', [journalId]);
      touched.current = false;
      await onSaved({
        ids,
        day,
        part: 'evening',
        onUndone: () => {
          setLogged(before);
          clearSaved(day, 'evening');
          touched.current = true;
          writeDraft(day, 'evening', latest.current);
          // Taken back: nothing was sent, so no summary is asked for, and the form is open again.
          setReopened(true);
          setWaitingIds(null);
          setSummary({ kind: 'none' });
        },
        onRefused: (refused) => {
          if (moodId !== null && refused.has(moodId)) setLogged(before);
        },
      });
      // The day is closed and saved whatever the AI does. Its summary waits until the events are accepted.
      if (aiCheckin === 'evening') {
        setSummary({ kind: 'waiting' });
        setWaitingIds(ids);
      }
    });

  const closeNow = useRef(close);
  closeNow.current = close;
  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = () => closeNow.current();
    return () => {
      saveRef.current = null;
    };
  }, [saveRef]);

  return (
    <Card title="يومية المساء" class="day-form">
      {closure.waiting ? (
        <p class="closure-pending" role="status">
          {closure.offline ? 'أُغلق اليوم · يُرسل عند عودة الاتصال' : 'أُغلق اليوم · قيد الإرسال'}
        </p>
      ) : (
        <ClosureCard day={day} closed={closure.closed} />
      )}

      {aiCheckin === 'evening' && closure.closed && (
        <ClosureAi
          day={day}
          summary={summary}
          maxLines={aiLines}
          stored={summary.kind === 'none' && !closure.waiting}
          offline={closure.offline}
          onAsk={() => void askSummary(true)}
        />
      )}

      {folded ? (
        <section class="day-section day-closed" aria-labelledby="e-closed">
          <h3 id="e-closed" class="day-h">
            ما سُجّل اليوم
          </h3>
          <dl class="day-closed-list">
            {state.score !== null && (
              <div>
                <dt>المزاج</dt>
                <dd>{`${fmt.num(state.score)} من ${fmt.num(5)}`}</dd>
              </div>
            )}
            {state.win.trim() !== '' && (
              <div>
                <dt>إنجاز اليوم</dt>
                <dd>{state.win}</dd>
              </div>
            )}
            {state.learned.trim() !== '' && (
              <div>
                <dt>تعلّمت</dt>
                <dd>{state.learned}</dd>
              </div>
            )}
            {state.gratitude.some((g) => g.trim() !== '') && (
              <div>
                <dt>الامتنان</dt>
                <dd>{state.gratitude.filter((g) => g.trim() !== '').join('، ')}</dd>
              </div>
            )}
            {state.note.trim() !== '' && (
              <div>
                <dt>اليومية</dt>
                <dd>{state.note}</dd>
              </div>
            )}
          </dl>
          <div class="day-actions">
            <Button onClick={() => setReopened(true)}>تعديل الإغلاق</Button>
          </div>
        </section>
      ) : (
        <>
        <section class="day-section">
          <Switch
            checked={state.oneMinute}
            onChange={(oneMinute) => update({ oneMinute })}
            label="دقيقة واحدة"
            hint="يُخفي منزلقات الحالة وحقل «تعلّمت»"
          />
        </section>

        <section class="day-section" aria-labelledby="e-mood">
          <h3 id="e-mood" class="day-h">
            المزاج
          </h3>
          <MoodScale value={state.score} onChange={(s) => update({ score: s })} />
          <div class="day-group">
            <p class="day-sub">المشاعر</p>
            <FeelingChips selected={state.feelings} onChange={(feelings) => update({ feelings })} />
          </div>
          <div class="day-group">
            <p class="day-sub">الأنشطة</p>
            <ActivityChips
              habits={habits}
              selected={activities}
              unavailable={!habitsKnown}
              onChange={(next) => update({ activities: next })}
            />
          </div>
          <div class="day-actions">
            <Button disabled={!moodDirty || busy} onClick={() => void saveMood()}>
              تسجيل المزاج
            </Button>
          </div>
        </section>

        <section class="day-section" aria-labelledby="e-priorities">
          <h3 id="e-priorities" class="day-h">
            أولويات الصباح
          </h3>
          {state.priorities.length === 0 ? (
            <div class="state-message">
              <p class="state-text">لا أولويات من الصباح.</p>
              <a class="btn btn-quiet" href="/day/morning">
                كتابة أولويات الصباح
              </a>
            </div>
          ) : (
            <ul class="day-priorities">
              {state.priorities.map((p, i) => (
                <li key={p.title} class="day-priority">
                  <CheckRow
                    shape="square"
                    label={p.title}
                    note={p.state === 'moved' ? 'نُقلت إلى الغد' : undefined}
                    checked={p.state === 'done'}
                    onToggle={(checked) => setPriority(i, checked ? 'done' : 'open')}
                  />
                  <Button
                    aria-pressed={p.state === 'moved' ? 'true' : 'false'}
                    onClick={() => setPriority(i, p.state === 'moved' ? 'open' : 'moved')}
                  >
                    نقل للغد
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {!state.oneMinute && (
          <section class="day-section" aria-labelledby="e-sliders">
            <h3 id="e-sliders" class="day-h">
              الحالة اليوم
            </h3>
            <div class="day-scores">
              <Score label="الهدوء" value={state.calm} onChange={(calm) => update({ calm })} />
              <Score label="التشتت" value={state.distraction} onChange={(distraction) => update({ distraction })} />
              <Score label="الحضور" value={state.presence} onChange={(presence) => update({ presence })} />
            </div>
          </section>
        )}

        <section class="day-section" aria-labelledby="e-win">
          <h3 id="e-win" class="day-h">
            الإنجاز
          </h3>
          <Field label="إنجاز اليوم" value={state.win} maxLength={LIMITS.win} onInput={(win) => update({ win })} />
          <div class="field">
            <label class="field-label" for={outcomeId}>
              المخرج
            </label>
            <select
              id={outcomeId}
              class="field-input day-select"
              value={state.winOutcome}
              onChange={(event) => update({ winOutcome: event.currentTarget.value })}
            >
              <option value="">بلا مخرج</option>
              {OUTCOMES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </section>

        {!state.oneMinute && (
          <section class="day-section">
            <Field
              label="تعلّمت"
              value={state.learned}
              maxLength={LIMITS.learned}
              onInput={(learned) => update({ learned })}
              multiline
            />
          </section>
        )}

        <section class="day-section" aria-labelledby="e-gratitude">
          <h3 id="e-gratitude" class="day-h">
            الامتنان
          </h3>
          <GratitudeFields values={state.gratitude} onChange={(gratitude) => update({ gratitude })} />
        </section>

        <OnThisDay day={day} entries={entries} />

        <section class="day-section">
          <Field
            label="اليومية"
            hint="نص حر. يبقى مسودة على هذا الجهاز حتى يقبله الخادم"
            multiline
            value={state.note}
            maxLength={LIMITS.note}
            onInput={(note) => update({ note })}
          />
        </section>

        <div class="day-actions">
          <Button variant="primary" disabled={busy} onClick={() => void close()}>
            إغلاق اليوم
          </Button>
        </div>
        </>
      )}
      {ai.dialog}
    </Card>
  );
}
