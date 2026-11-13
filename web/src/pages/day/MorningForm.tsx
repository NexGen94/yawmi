import { useEffect, useRef, useState } from 'preact/hooks';

import { ConsentNotice } from '../../ai/ConsentDialog';
import { DeeperBlock } from '../../ai/DeeperBlock';
import { acceptInsight, type GroundedInsight, UNAVAILABLE_TEXT } from '../../ai/guard';
import { InsightCard } from '../../ai/InsightCard';
import { unwrapAi, useAi } from '../../ai/useAi';
import { api } from '../../api/client';
import type { components } from '../../api/schema';
import { saveJournal } from '../../data/events';
import type { JournalEntryOut } from '../../data/pending';
import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';
import { OFFLINE_NOTE } from '../../lib/notes';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Chips } from '../../ui/Chips';
import { Field } from '../../ui/Field';
import { clearSaved, readDraft, markSaved, writeDraft } from './draft';
import { GratitudeFields } from './GratitudeFields';
import { LIMITS } from './limits';
import type { SaveRecord } from './SaveStatus';
import { cardLabel, sourceLabel } from './sourceLabel';
import type { DayHabit, TodayOut } from './useDayData';

type MorningAnswers = components['schemas']['MorningAnswers'];

/** The planned focus minutes of the morning (feature of the morning card). */
export const PLANNED_MINUTES = [30, 60, 90, 120, 175] as const;

/** At most three priorities: the design gives three fields and no way to add a fourth. */
const SLOTS = LIMITS.priorities;

/** `suggested`: the insight proposes it and nothing is decided. `accepted`: kept as proposed, with
 *  its source. `own`: the person's words (a replaced suggestion is `own` and empty). */
type SlotMode = 'own' | 'suggested' | 'accepted';

interface Slot {
  title: string;
  source_id: string | null;
  goal_ref: string | null;
  mode: SlotMode;
}

interface MorningState {
  slots: Slot[];
  planned: number | null;
  enthusiasm: string;
  gratitude: string[];
  note: string;
}

const emptySlot = (): Slot => ({ title: '', source_id: null, goal_ref: null, mode: 'own' });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function fromEntry(answers: JournalEntryOut['answers']): MorningState {
  const saved = Array.isArray(answers.priorities) ? (answers.priorities as Record<string, unknown>[]) : [];
  const slots = Array.from({ length: SLOTS }, (_, i): Slot => {
    const p = saved[i];
    if (!p) return emptySlot();
    const source = typeof p.source_id === 'string' ? p.source_id : null;
    return {
      title: str(p.title),
      source_id: source,
      goal_ref: typeof p.goal_ref === 'string' ? p.goal_ref : null,
      mode: source === null ? 'own' : 'accepted',
    };
  });
  const gratitude = Array.isArray(answers.gratitude) ? answers.gratitude.map(str) : [];
  return {
    slots,
    planned: typeof answers.planned_minutes === 'number' ? answers.planned_minutes : null,
    enthusiasm: str(answers.enthusiasm),
    gratitude: [0, 1, 2].map((i) => gratitude[i] ?? ''),
    note: str(answers.note),
  };
}

function fromInsight(insight: GroundedInsight | null | undefined): MorningState {
  const proposed = insight?.priorities ?? [];
  return {
    slots: Array.from({ length: SLOTS }, (_, i): Slot => {
      const p = proposed[i];
      return p ? { title: p.title, source_id: p.source_id, goal_ref: null, mode: 'suggested' } : emptySlot();
    }),
    planned: null,
    enthusiasm: '',
    gratitude: ['', '', ''],
    note: '',
  };
}

function isState(value: unknown): value is MorningState {
  const s = value as Partial<MorningState> | undefined;
  return Array.isArray(s?.slots) && s.slots.length === SLOTS && Array.isArray(s.gratitude) && typeof s.note === 'string';
}

export interface MorningFormProps {
  day: Day;
  /** The saved (or queued) morning of this day, if any. */
  entry: JournalEntryOut | undefined;
  insight: TodayOut['insight'];
  /** `ai_lines` (2 until the settings are read). */
  aiLines?: 1 | 2;
  /** `ai_checkin`: with `morning` the card of the day summary is on this page. */
  aiCheckin?: 'morning' | 'evening';
  /** The visit asks for the morning insight once by itself (today is read, it has no insight yet). */
  autoSuggest?: boolean;
  /** Today's habits, to name a suggestion that comes from one. */
  habits: readonly DayHabit[];
  onSaved(record: SaveRecord): Promise<void>;
  /** The page can save this form too (the notice about yesterday's text does). */
  saveRef?: { current: (() => Promise<void>) | null };
}

/** The morning card: priorities (proposed ones to accept or replace), planned minutes, one line of
 *  enthusiasm, up to three gratitude lines and the free text. Saving queues one `journal_saved`. */
export function MorningForm({ day, entry, insight, habits, onSaved, saveRef, ...rest }: MorningFormProps) {
  const aiLines = rest.aiLines ?? 2;
  const aiCheckin = rest.aiCheckin ?? 'evening';
  // A stored insight may be older than task 18 (no cards): its words still show, so it is looked at
  // without asking for its cards. One that breaks a limit is not shown.
  const stored = insight ? acceptInsight(insight, aiLines, { cardsOptional: true }) : null;
  const draft = readDraft<MorningState>(day, 'morning');
  const [state, setState] = useState<MorningState>(() => {
    if (isState(draft)) return draft;
    return entry ? fromEntry(entry.answers) : fromInsight(stored);
  });
  const [busy, setBusy] = useState(false);
  const ai = useAi();
  const [ask, setAsk] = useState<'idle' | 'loading' | 'consent' | 'offline' | 'error'>('idle');
  const [proposal, setProposal] = useState<GroundedInsight | null>(null);
  const autoAsked = useRef(false);
  // The draft mirrors the form only while it holds words that were not saved.
  const touched = useRef(isState(draft));
  const saving = useRef(false);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    if (touched.current) writeDraft(day, 'morning', state);
  }, [day, state]);

  const update = (patch: Partial<MorningState>): void => {
    touched.current = true;
    // Words changed after a save: they are not what the queue holds.
    clearSaved(day, 'morning');
    setState((s) => ({ ...s, ...patch }));
  };
  const setSlot = (i: number, slot: Slot): void => update({ slots: state.slots.map((s, j) => (j === i ? slot : s)) });

  /** «اقتراح أولويات»: one request for the day, made when it is pressed (never by itself, and not
   *  again after a log). The proposals fill the slots that hold no words of the person. */
  const suggest = async (auto = false): Promise<void> => {
    if (!auto) setAsk('loading');
    // The visit's own call never opens the consent dialog nobody asked for: without a consent the
    // notice shows, with its button.
    const result = await ai.run(() => api.POST('/v1/insights/morning', { body: { day, regenerate: false } }).then(unwrapAi), {
      prompt: !auto,
    });
    if (result.kind === 'ok') {
      const accepted = acceptInsight(result.value, aiLines);
      if (accepted === null) return setAsk(auto ? 'idle' : 'error');
      setProposal(accepted);
      setAsk('idle');
      // Not words of the person: no draft is made of them.
      setState((s) => ({
        ...s,
        slots: s.slots.map((slot, i): Slot => {
          const p = accepted.priorities[i];
          const free = slot.mode === 'suggested' || (slot.mode === 'own' && slot.title.trim() === '');
          return p && free ? { title: p.title, source_id: p.source_id, goal_ref: null, mode: 'suggested' } : slot;
        }),
      }));
    } else if (result.kind === 'consent_required') setAsk('consent');
    else if (auto) setAsk('idle'); // a failed visit call is silent: the button asks again
    else if (result.kind === 'offline') setAsk('offline');
    else setAsk('error');
  };

  // One automatic call per visit: the guard is a ref, so a log, a re-render or a new reading of the
  // queue cannot make a second one.
  useEffect(() => {
    if (!rest.autoSuggest || entry !== undefined || autoAsked.current) return;
    autoAsked.current = true;
    void suggest(true);
  }, [rest.autoSuggest]);

  const shown: GroundedInsight | null = proposal ?? stored;
  const cards = shown?.cards ?? [];

  const save = async (): Promise<void> => {
    if (saving.current) return; // a second click while the first is on its way
    saving.current = true;
    setBusy(true);
    try {
      const priorities = state.slots
        .filter((s) => s.mode !== 'suggested' && s.title.trim() !== '')
        .map((s) => ({ title: s.title.trim(), source_id: s.source_id, goal_ref: s.goal_ref }));
      const answers: MorningAnswers = {
        priorities,
        planned_minutes: state.planned,
        enthusiasm: state.enthusiasm.trim() || null,
        gratitude: state.gratitude.map((g) => g.trim()).filter((g) => g !== ''),
        note: state.note.trim() || null,
      };
      const id = await saveJournal('morning', answers, day);
      // The draft stays until the server has accepted the events (reconcileDrafts), so a refusal
      // or a reload loses nothing.
      writeDraft(day, 'morning', latest.current);
      markSaved(day, 'morning', [id]);
      touched.current = false;
      await onSaved({
        ids: [id],
        day,
        part: 'morning',
        onUndone: () => {
          clearSaved(day, 'morning');
          touched.current = true;
          writeDraft(day, 'morning', latest.current);
        },
      });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const saveNow = useRef(save);
  saveNow.current = save;
  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = () => saveNow.current();
    return () => {
      saveRef.current = null;
    };
  }, [saveRef]);

  return (
    <Card title="يومية الصباح" class="day-form">
      {aiCheckin === 'morning' && insight && stored === null && proposal === null && (
        <section class="day-ai" aria-label="ملخص اليوم من الذكاء">
          <p class="ai-note">{UNAVAILABLE_TEXT}</p>
        </section>
      )}
      {aiCheckin === 'morning' && shown !== null && (
        <Card title="ملخص اليوم من الذكاء" headingLevel={3} class="day-ai">
          <InsightCard insight={shown} maxLines={aiLines} hideQuestion={Boolean(shown.question)}>
            {shown.question && <DeeperBlock day={day} question={shown.question} />}
          </InsightCard>
        </Card>
      )}
      <section class="day-section" aria-labelledby="m-priorities">
        <h3 id="m-priorities" class="day-h">
          الأولويات
        </h3>
        <div class="day-suggest">
          <Button disabled={ask === 'loading'} onClick={() => void suggest()}>
            اقتراح أولويات
          </Button>
          {ask === 'loading' && (
            <p class="day-note" role="status">
              جارٍ التحليل
            </p>
          )}
          {ask === 'offline' && (
            <p class="day-note" role="status">
              {OFFLINE_NOTE}
            </p>
          )}
          {ask === 'error' && (
            <p class="day-note" role="alert">
              {UNAVAILABLE_TEXT}
            </p>
          )}
          {ask === 'consent' && <ConsentNotice onEnable={() => void suggest()} />}
        </div>
        <ol class="day-slots">
          {state.slots.map((slot, i) => {
            const source = slot.source_id === null ? null : (cardLabel(slot.source_id, cards) ?? sourceLabel(slot.source_id, habits));
            return (
              <li key={i}>
                {slot.mode === 'own' ? (
                  <Field
                    label={`الأولوية ${fmt.num(i + 1)}`}
                    value={slot.title}
                    maxLength={LIMITS.title}
                    onInput={(title) => setSlot(i, { ...slot, title })}
                  />
                ) : (
                  <div class="day-suggestion">
                    <div class="day-suggestion-text">
                      <span class="day-suggestion-title" dir="auto">
                        {slot.title}
                      </span>
                      {source && (
                        <span class="day-suggestion-source">
                          المصدر{' '}
                          <Badge>
                            {source.kind} <bdi dir="auto">{source.ref}</bdi>
                          </Badge>
                        </span>
                      )}
                    </div>
                    <div class="day-suggestion-actions">
                      {slot.mode === 'suggested' ? (
                        <Button onClick={() => setSlot(i, { ...slot, mode: 'accepted' })}>قبول</Button>
                      ) : (
                        <Badge>مقبولة</Badge>
                      )}
                      <Button onClick={() => setSlot(i, emptySlot())}>استبدال</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section class="day-section" aria-labelledby="m-minutes">
        <h3 id="m-minutes" class="day-h">
          الدقائق المقررة
        </h3>
        <Chips
          label="الدقائق المقررة"
          options={PLANNED_MINUTES.map((m) => ({ value: String(m), label: fmt.num(m) }))}
          selected={state.planned === null ? [] : [String(state.planned)]}
          onChange={(next) => {
            // One choice: the chip tapped now replaces the one chosen before; tapping it again clears it.
            const fresh = next.find((v) => v !== String(state.planned));
            update({ planned: fresh === undefined ? null : Number(fresh) });
          }}
        />
      </section>

      <section class="day-section">
        <Field
          label="سطر الحماس"
          hint="سطر واحد عمّا يُنتظر اليوم"
          value={state.enthusiasm}
          maxLength={LIMITS.enthusiasm}
          onInput={(enthusiasm) => update({ enthusiasm })}
        />
      </section>

      <section class="day-section" aria-labelledby="m-gratitude">
        <h3 id="m-gratitude" class="day-h">
          الامتنان
        </h3>
        <GratitudeFields values={state.gratitude} onChange={(gratitude) => update({ gratitude })} />
      </section>

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
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          حفظ الصباح
        </Button>
      </div>
      {ai.dialog}
    </Card>
  );
}
