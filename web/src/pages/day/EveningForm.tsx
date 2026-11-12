import { useEffect, useId, useRef, useState } from 'preact/hooks';

import type { components } from '../../api/schema';
import { logMood, saveJournal } from '../../data/events';
import type { JournalEntryOut, MoodLogOut } from '../../data/pending';
import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { CheckRow } from '../../ui/CheckRow';
import { Field } from '../../ui/Field';
import { Slider } from '../../ui/Slider';
import { ActivityChips } from './ActivityChips';
import { ClosureCard } from './ClosureCard';
import { clearDraft, readDraft, writeDraft } from './draft';
import { FeelingChips } from './FeelingChips';
import { GratitudeFields } from './GratitudeFields';
import { MoodScale } from './MoodScale';
import { OnThisDay } from './OnThisDay';
import type { SaveRecord } from './SaveStatus';
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
const cap = (value: string, max: number): string => value.slice(0, max);

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

const sorted = (a: readonly string[]): string[] => [...a].sort();
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
  /** The saved (or queued) evening of today, if any. */
  evening: JournalEntryOut | undefined;
  /** The journal of the last 30 days, for «في مثل هذا اليوم». */
  entries: readonly JournalEntryOut[];
  mood: MoodLogOut | undefined;
  habits: readonly DayHabit[];
  doneCodes: readonly string[];
  closure: Closure;
  onSaved(record: SaveRecord): Promise<void>;
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
  const { day, morning, evening, entries, mood, habits, doneCodes, closure, onSaved } = props;
  const draft = readDraft<EveningState>(day, 'evening');
  const [state, setState] = useState<EveningState>(() => {
    const restored = isState(draft) ? draft : undefined;
    const base = fromEntry(evening, morning, mood, restored);
    return restored ? { ...restored, priorities: base.priorities } : base;
  });
  const [logged, setLogged] = useState<string | null>(() => (mood ? signature(mood.score, mood.feelings, mood.activities) : null));
  const touched = useRef(isState(draft));
  const latest = useRef(state);
  latest.current = state;
  const outcomeId = useId();
  const switchId = useId();

  useEffect(() => {
    if (touched.current) writeDraft(day, 'evening', state);
  }, [day, state]);

  const update = (patch: Partial<EveningState>): void => {
    touched.current = true;
    setState((s) => ({ ...s, ...patch }));
  };
  const setPriority = (i: number, next: PriorityState): void =>
    update({ priorities: state.priorities.map((p, j) => (j === i ? { ...p, state: next } : p)) });

  const activities = state.activities ?? [...doneCodes];
  const moodSignature = state.score === null ? null : signature(state.score, state.feelings, activities);
  const moodDirty = moodSignature !== null && moodSignature !== logged;

  /** Queues the mood when there is a new one; returns its event id. */
  const queueMood = async (): Promise<string | null> => {
    if (state.score === null || !moodDirty) return null;
    const id = await logMood({ day, score: state.score, feelings: state.feelings, activities });
    setLogged(moodSignature);
    return id;
  };

  const saveMood = async (): Promise<void> => {
    const before = logged;
    const id = await queueMood();
    if (id !== null) await onSaved({ ids: [id], onUndone: () => setLogged(before) });
  };

  const close = async (): Promise<void> => {
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
    ids.push(await saveJournal('evening', answers, day));
    touched.current = false;
    clearDraft(day, 'evening');
    await onSaved({
      ids,
      onUndone: () => {
        setLogged(before);
        touched.current = true;
        writeDraft(day, 'evening', latest.current);
      },
    });
  };

  return (
    <Card title="يومية المساء" class="day-form">
      {closure.waiting ? (
        <p class="closure-pending" role="status">
          {closure.offline ? 'أُغلق اليوم · يُرسل عند عودة الاتصال' : 'أُغلق اليوم · قيد الإرسال'}
        </p>
      ) : (
        <ClosureCard day={day} closed={closure.closed} />
      )}

      <section class="day-section">
        <button
          type="button"
          role="switch"
          class="day-switch"
          aria-checked={state.oneMinute ? 'true' : 'false'}
          aria-labelledby={`${switchId}-label`}
          aria-describedby={`${switchId}-hint`}
          onClick={() => update({ oneMinute: !state.oneMinute })}
        >
          <span class="day-switch-track" aria-hidden="true">
            <span class="day-switch-thumb" />
          </span>
          <span class="day-switch-text">
            <span id={`${switchId}-label`} class="day-switch-label">
              دقيقة واحدة
            </span>
            <span id={`${switchId}-hint`} class="day-switch-hint">
              المزاج والأولويات والإنجاز فقط
            </span>
          </span>
        </button>
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
          <ActivityChips habits={habits} selected={activities} onChange={(next) => update({ activities: next })} />
        </div>
        <div class="day-actions">
          <Button disabled={!moodDirty} onClick={() => void saveMood()}>
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
                <Button aria-pressed={p.state === 'moved' ? 'true' : 'false'} onClick={() => setPriority(i, p.state === 'moved' ? 'open' : 'moved')}>
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
        <Field label="إنجاز اليوم" value={state.win} onInput={(win) => update({ win: cap(win, 300) })} />
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
          <Field label="تعلّمت" value={state.learned} onInput={(learned) => update({ learned: cap(learned, 300) })} multiline />
        </section>
      )}

      <section class="day-section" aria-labelledby="e-gratitude">
        <h3 id="e-gratitude" class="day-h">
          الامتنان
        </h3>
        <GratitudeFields values={state.gratitude} onChange={(gratitude) => update({ gratitude: gratitude.map((g) => cap(g, 200)) })} />
      </section>

      <OnThisDay day={day} entries={entries} />

      <section class="day-section">
        <Field
          label="اليومية"
          hint="نص حر. يبقى مسودة على هذا الجهاز حتى الإغلاق"
          multiline
          value={state.note}
          onInput={(note) => update({ note: cap(note, 2000) })}
        />
      </section>

      <div class="day-actions">
        <Button variant="primary" onClick={() => void close()}>
          إغلاق اليوم
        </Button>
      </div>
    </Card>
  );
}
