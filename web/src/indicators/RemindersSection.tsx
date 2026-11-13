// The «إضافة تذكير» section of the indicator dialog (design 9.3, the controller's ruling 1). A habit
// has up to three reminders of its own, and the section adds to them or changes one; a goal has the
// one reminder of its indicator. The dialog decides where a change is saved (the habit, or the
// indicator): this part only edits the list and says what is wrong with it.

import { useState } from 'preact/hooks';

import { ALL_DAYS, maskOf, namesOf, WEEKDAYS } from '../habits/days';
import { maxReminders } from '../habits/form';
import type { ReminderIn } from '../habits/types';
import { fmt } from '../lib/format';
import { Button } from '../ui/Button';
import { Chips } from '../ui/Chips';
import { Disclosure } from '../ui/Disclosure';
import { Field } from '../ui/Field';

export const OFFLINE_NOTE = 'يحتاج اتصالاً';
export const LIMIT_NOTE = 'ثلاثة تذكيرات على الأكثر';
/** What a new reminder starts as: the evening, every day. */
export const NEW_REMINDER: ReminderIn = { time: '20:00', days_mask: ALL_DAYS };

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_OPTIONS = WEEKDAYS.map((name) => ({ value: name, label: name }));

function daysWord(mask: number): string {
  if (mask === ALL_DAYS) return 'كل يوم';
  return namesOf(mask).join('، ') || 'لا يوم';
}

/** What is wrong with a reminder, or nothing. */
export function reminderError(reminder: ReminderIn): string | undefined {
  if (reminder.time === '') return 'الوقت مطلوب.';
  if (!CLOCK.test(reminder.time)) return 'الوقت بصيغة HH:mm.';
  if (reminder.days_mask < 1 || reminder.days_mask > ALL_DAYS) return 'يوم واحد على الأقل.';
  return undefined;
}

interface RowProps {
  name: string;
  reminder: ReminderIn;
  onChange(next: ReminderIn): void;
  error: string | undefined;
}

/** The time and the days of one reminder. */
function ReminderRow({ name, reminder, onChange, error }: RowProps) {
  return (
    <>
      <Field label={`وقت التذكير ${name}`} type="time" value={reminder.time} onInput={(time) => onChange({ ...reminder, time })} error={error} />
      <Disclosure summary={`الأيام: ${daysWord(reminder.days_mask)}`}>
        <Chips
          label={`أيام التذكير ${name}`}
          options={DAY_OPTIONS}
          selected={namesOf(reminder.days_mask)}
          onChange={(names) => onChange({ ...reminder, days_mask: maskOf(names) })}
        />
      </Disclosure>
    </>
  );
}

interface EditProps {
  n: number;
  reminder: ReminderIn;
  disabled: boolean;
  onSave(next: ReminderIn): Promise<boolean>;
  /** A goal's one reminder can be taken away; a habit's are removed in the editor. */
  onRemove?: () => Promise<boolean>;
}

/** A reminder that exists: its own time and days, saved on their own. */
function EditReminder({ n, reminder, disabled, onSave, onRemove }: EditProps) {
  const [draft, setDraft] = useState(reminder);
  const [error, setError] = useState<string | undefined>(undefined);
  const changed = draft.time !== reminder.time || draft.days_mask !== reminder.days_mask;
  const save = async (): Promise<void> => {
    const problem = reminderError(draft);
    setError(problem);
    if (problem === undefined) await onSave(draft);
  };
  return (
    <div class="reminder-edit">
      <ReminderRow
        name={fmt.num(n)}
        reminder={draft}
        error={error}
        onChange={(next) => {
          setError(undefined);
          setDraft(next);
        }}
      />
      <div class="reminder-edit-actions">
        <Button disabled={disabled || !changed} onClick={() => void save()} aria-label={`حفظ التذكير ${fmt.num(n)}`}>
          {onRemove ? 'حفظ التذكير' : `حفظ التذكير ${fmt.num(n)}`}
        </Button>
        {onRemove && (
          <Button disabled={disabled} onClick={() => void onRemove()}>
            حذف التذكير
          </Button>
        )}
      </div>
    </div>
  );
}

export interface RemindersSectionProps {
  kind: 'habit' | 'goal';
  /** The reminders that exist: a habit's, or the one of a goal's indicator. */
  reminders: readonly ReminderIn[];
  online: boolean;
  /** Saves the whole list the person means; true when the server took it. */
  onSave(next: ReminderIn[]): Promise<boolean>;
}

export function RemindersSection({ kind, reminders, online, onSave }: RemindersSectionProps) {
  const [fresh, setFresh] = useState<ReminderIn>(NEW_REMINDER);
  const [error, setError] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const limit = kind === 'habit' ? maxReminders : 1;
  const full = reminders.length >= limit;
  const disabled = !online || busy;

  const run = async (next: ReminderIn[]): Promise<boolean> => {
    setBusy(true);
    setSaved(false);
    setFailed(false);
    const ok = await onSave(next);
    setBusy(false);
    setSaved(ok);
    setFailed(!ok);
    return ok;
  };

  const add = async (): Promise<void> => {
    const problem = reminderError(fresh);
    setError(problem);
    if (problem !== undefined) return;
    if (await run([...reminders, { ...fresh }])) setFresh(NEW_REMINDER);
  };

  return (
    <section class="indicator-reminders" aria-label="التذكيرات">
      <h3 class="indicator-group-title">التذكيرات</h3>
      {reminders.map((reminder, i) => (
        <EditReminder
          key={`${i}-${reminder.time}-${reminder.days_mask}`}
          n={i + 1}
          reminder={reminder}
          disabled={disabled}
          onSave={(next) => run(reminders.map((r, j) => (j === i ? next : r)))}
          onRemove={kind === 'goal' ? () => run([]) : undefined}
        />
      ))}
      {!full && (
        <div class="reminder-edit">
          <ReminderRow
            name="الجديد"
            reminder={fresh}
            error={error}
            onChange={(next) => {
              setError(undefined);
              setFresh(next);
            }}
          />
          <div class="reminder-edit-actions">
            <Button disabled={disabled} onClick={() => void add()}>
              إضافة تذكير
            </Button>
          </div>
        </div>
      )}
      {full && kind === 'habit' && (
        <div class="reminder-edit-actions">
          <Button disabled>إضافة تذكير</Button>
          <p class="indicator-hint">{LIMIT_NOTE}</p>
        </div>
      )}
      {!online && <p class="indicator-hint">{OFFLINE_NOTE}</p>}
      {failed && (
        <p class="indicator-error" role="alert">
          تعذّر الحفظ؛ يمكن المحاولة ثانية
        </p>
      )}
      {saved && (
        <p class="indicator-status" role="status">
          تم الحفظ
        </p>
      )}
    </section>
  );
}
