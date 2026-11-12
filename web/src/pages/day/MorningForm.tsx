import { useEffect, useRef, useState } from 'preact/hooks';

import type { components } from '../../api/schema';
import { saveJournal } from '../../data/events';
import type { JournalEntryOut } from '../../data/pending';
import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Chips } from '../../ui/Chips';
import { Field } from '../../ui/Field';
import { clearDraft, readDraft, writeDraft } from './draft';
import { GratitudeFields } from './GratitudeFields';
import type { SaveRecord } from './SaveStatus';
import type { TodayOut } from './useDayData';

type MorningAnswers = components['schemas']['MorningAnswers'];

/** The planned focus minutes of the morning (feature of the morning card). */
export const PLANNED_MINUTES = [30, 60, 90, 120, 175] as const;

/** At most three priorities: the design gives three fields and no way to add a fourth. */
const SLOTS = 3;

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

function fromInsight(insight: TodayOut['insight']): MorningState {
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
  /** The saved (or queued) morning of today, if any. */
  entry: JournalEntryOut | undefined;
  insight: TodayOut['insight'];
  onSaved(record: SaveRecord): Promise<void>;
}

/** The morning card: priorities (proposed ones to accept or replace), planned minutes, one line of
 *  enthusiasm, up to three gratitude lines and the free text. Saving queues one `journal_saved`. */
export function MorningForm({ day, entry, insight, onSaved }: MorningFormProps) {
  const draft = readDraft<MorningState>(day, 'morning');
  const [state, setState] = useState<MorningState>(() => {
    if (isState(draft)) return draft;
    return entry ? fromEntry(entry.answers) : fromInsight(insight);
  });
  // The draft mirrors the form only while it holds words that were not saved.
  const touched = useRef(isState(draft));
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    if (touched.current) writeDraft(day, 'morning', state);
  }, [day, state]);

  const update = (patch: Partial<MorningState>): void => {
    touched.current = true;
    setState((s) => ({ ...s, ...patch }));
  };
  const setSlot = (i: number, slot: Slot): void => update({ slots: state.slots.map((s, j) => (j === i ? slot : s)) });

  const save = async (): Promise<void> => {
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
    touched.current = false;
    clearDraft(day, 'morning');
    await onSaved({
      ids: [id],
      onUndone: () => {
        touched.current = true;
        writeDraft(day, 'morning', latest.current);
      },
    });
  };

  return (
    <Card title="يومية الصباح" class="day-form">
      <section class="day-section" aria-labelledby="m-priorities">
        <h3 id="m-priorities" class="day-h">
          الأولويات
        </h3>
        <ol class="day-slots">
          {state.slots.map((slot, i) => (
            <li key={i}>
              {slot.mode === 'own' ? (
                <Field
                  label={`الأولوية ${fmt.num(i + 1)}`}
                  value={slot.title}
                  onInput={(title) => setSlot(i, { ...slot, title })}
                />
              ) : (
                <div class="day-suggestion">
                  <div class="day-suggestion-text">
                    <span class="day-suggestion-title" dir="auto">
                      {slot.title}
                    </span>
                    <span class="day-suggestion-source">
                      المصدر{' '}
                      <Badge>
                        <bdi dir="ltr">{slot.source_id}</bdi>
                      </Badge>
                    </span>
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
          ))}
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
          hint="نص حر. يبقى مسودة على هذا الجهاز حتى الحفظ"
          multiline
          value={state.note}
          onInput={(note) => update({ note })}
        />
      </section>

      <div class="day-actions">
        <Button variant="primary" onClick={() => void save()}>
          حفظ الصباح
        </Button>
      </div>
    </Card>
  );
}
