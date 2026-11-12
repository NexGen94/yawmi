import { ALL_DAYS, maskOf, namesOf, WEEKDAYS } from '../../habits/days';
import { maxReminders } from '../../habits/form';
import type { ReminderIn } from '../../habits/types';
import { fmt } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Chips } from '../../ui/Chips';
import { Field } from '../../ui/Field';

const DAY_OPTIONS = WEEKDAYS.map((name) => ({ value: name, label: name }));
/** A new reminder: the morning, every day. */
const NEW_REMINDER: ReminderIn = { time: '07:00', days_mask: ALL_DAYS };

export interface ReminderFieldsProps {
  reminders: ReminderIn[];
  error?: string;
  onChange(next: ReminderIn[]): void;
}

/** Up to three reminders, each a time and the days it rings on. */
export function ReminderFields({ reminders, error, onChange }: ReminderFieldsProps) {
  const set = (index: number, next: ReminderIn): void => onChange(reminders.map((r, i) => (i === index ? next : r)));
  return (
    <fieldset class="editor-reminders" aria-label="التذكيرات">
      <p class="field-label" aria-hidden="true">
        التذكيرات
      </p>
      {reminders.map((reminder, i) => {
        const n = i + 1;
        return (
          <div class="reminder-row" key={i}>
            <Field label={`وقت التذكير ${fmt.num(n)}`} type="time" value={reminder.time} onInput={(time) => set(i, { ...reminder, time })} />
            <Chips
              label={`أيام التذكير ${fmt.num(n)}`}
              options={DAY_OPTIONS}
              selected={namesOf(reminder.days_mask)}
              onChange={(names) => set(i, { ...reminder, days_mask: maskOf(names) })}
            />
            <Button onClick={() => onChange(reminders.filter((_, j) => j !== i))} aria-label={`حذف التذكير ${fmt.num(n)}`}>
              حذف
            </Button>
          </div>
        );
      })}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <Button disabled={reminders.length >= maxReminders} onClick={() => onChange([...reminders, { ...NEW_REMINDER }])}>
        إضافة تذكير
      </Button>
      {reminders.length >= maxReminders && <p class="field-hint">الحد الأقصى {fmt.num(maxReminders)} تذكيرات.</p>}
    </fieldset>
  );
}
