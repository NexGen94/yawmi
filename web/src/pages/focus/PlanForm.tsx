import { useId, useState } from 'preact/hooks';

import type { components } from '../../api/schema';
import { maskOf, WEEKDAYS } from '../../focus/format';
import { fmt } from '../../lib/format';
import { OFFLINE_NOTE } from '../../lib/notes';
import { Button } from '../../ui/Button';
import { Chips } from '../../ui/Chips';
import { Field } from '../../ui/Field';

type FocusPlanIO = components['schemas']['FocusPlanIO'];

/** A duration habit a plan can feed with its minutes. */
export interface HabitChoice {
  code: string;
  title: string;
}

export interface PlanFormProps {
  online: boolean;
  habits: HabitChoice[];
  /** The goal of the current link, when there is one: the plan can keep it. */
  goalRef: string | null;
  /** Sends the plan; resolves with a sentence when it was not saved. */
  onSave(plan: FocusPlanIO): Promise<string | null>;
}

const DAY_OPTIONS = WEEKDAYS.map((label, i) => ({ value: String(i), label }));
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The form of a new plan: a title, minutes, and optionally favourite, days and time, a duration
 *  habit and the linked goal. Saving needs a connection (a setting call, design 13.1). */
export function PlanForm({ online, habits, goalRef, onSave }: PlanFormProps) {
  const habitId = useId();
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState('25');
  const [options, setOptions] = useState<string[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [time, setTime] = useState('');
  const [habit, setHabit] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    const n = Number(minutes);
    if (title.trim() === '') return setError('العنوان مطلوب');
    if (!Number.isInteger(n) || n < 5 || n > 240) return setError(`المدة من ${fmt.num(5)} إلى ${fmt.count(240, 'minute')}`);
    if ((days.length > 0) !== (time !== '')) return setError('الأيام والوقت معاً أو بدونهما');
    if (time !== '' && !TIME.test(time)) return setError('الوقت غير صالح');
    setError('');
    setSaving(true);
    const plan: FocusPlanIO = {
      title_ar: title.trim(),
      minutes: n,
      favorite: options.includes('favorite'),
      active: true,
      ...(habit !== '' ? { habit_code: habit } : {}),
      ...(options.includes('goal') && goalRef !== null ? { goal_ref: goalRef } : {}),
      ...(days.length > 0 ? { weekday_mask: maskOf(days.map(Number)), start_time: time } : {}),
    };
    const failed = await onSave(plan);
    setSaving(false);
    if (failed !== null) return setError(failed);
    setTitle('');
    setOptions([]);
    setDays([]);
    setTime('');
    setHabit('');
  };

  const choices = [
    { value: 'favorite', label: 'مفضلة' },
    ...(goalRef !== null ? [{ value: 'goal', label: 'ربط بالهدف الحالي' }] : []),
  ];

  return (
    <form class="focus-form" onSubmit={(e) => void submit(e)}>
      <Field label="عنوان الخطة" value={title} onInput={setTitle} maxLength={80} />
      <Field label="الدقائق" type="number" value={minutes} onInput={setMinutes} min={5} max={240} />
      <Chips label="خيارات الخطة" options={choices} selected={options} onChange={setOptions} />
      <Chips label="أيام الكتلة" options={DAY_OPTIONS} selected={days} onChange={setDays} />
      <Field label="وقت البدء" type="time" value={time} onInput={setTime} />
      {habits.length > 0 && (
        <div class="field">
          <label class="field-label" for={habitId}>
            عادة مدة مرتبطة
          </label>
          <select id={habitId} class="field-input" value={habit} onChange={(e) => setHabit(e.currentTarget.value)}>
            <option value="">بلا عادة</option>
            {habits.map((h) => (
              <option key={h.code} value={h.code}>
                {h.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="focus-actions">
        <Button type="submit" disabled={!online || saving}>
          حفظ الخطة
        </Button>
        {!online && <span class="focus-note">{OFFLINE_NOTE}</span>}
      </div>
    </form>
  );
}
