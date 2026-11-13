import { maskOf, namesOf, WEEKDAYS } from '../../habits/days';
import type { FormErrors, HabitForm } from '../../habits/form';
import type { ScheduleKind } from '../../habits/types';
import { Chips } from '../../ui/Chips';
import { Field } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { LockedGroup } from './LockedGroup';

const KINDS: readonly { value: ScheduleKind; label: string }[] = [
  { value: 'every_day', label: 'كل يوم' },
  { value: 'weekdays', label: 'أيام محددة' },
  { value: 'every_n_days', label: 'كل عدة أيام' },
];

const DAY_OPTIONS = WEEKDAYS.map((name) => ({ value: name, label: name }));

export interface ScheduleFieldsProps {
  form: HabitForm;
  errors: FormErrors;
  locked: boolean;
  lockHint?: string;
  onChange(next: HabitForm): void;
}

/** Which days of a daily habit count: every day, some weekdays, or every N days from an anchor day.
 *  A weekly or monthly habit has no schedule: its period is the unit. */
export function ScheduleFields({ form, errors, locked, lockHint, onChange }: ScheduleFieldsProps) {
  if (form.period !== 'day') return null;
  return (
    <>
      <LockedGroup label="الجدول" locked={locked} hint={lockHint} error={errors.schedule_kind}>
        <Segmented
          label="الجدول"
          disabled={locked}
          options={KINDS}
          value={form.schedule_kind}
          onChange={(kind) =>
            onChange({
              ...form,
              schedule_kind: kind,
              weekday_mask: kind === 'weekdays' ? (form.weekday_mask ?? null) : null,
              every_n: kind === 'every_n_days' ? (form.every_n ?? 2) : null,
              anchor_day: kind === 'every_n_days' ? (form.anchor_day ?? form.start_day) : null,
            })
          }
        />
      </LockedGroup>
      {form.schedule_kind === 'weekdays' && (
        <LockedGroup label="أيام الأسبوع" locked={locked} error={errors.weekday_mask}>
          <Chips
            label="أيام الأسبوع"
            disabled={locked}
            options={DAY_OPTIONS}
            selected={namesOf(form.weekday_mask)}
            onChange={(names) => onChange({ ...form, weekday_mask: names.length === 0 ? null : maskOf(names) })}
          />
        </LockedGroup>
      )}
      {form.schedule_kind === 'every_n_days' && (
        <div class="editor-date-pair">
          <Field
            label="التكرار كل كم يوماً"
            type="number"
            min={2}
            max={365}
            value={form.every_n === null ? '' : String(form.every_n)}
            onInput={(value) => onChange({ ...form, every_n: value === '' ? null : Number(value) })}
            error={errors.every_n}
            disabled={locked}
          />
          <Field
            label="يوم المرساة"
            type="date"
            value={form.anchor_day ?? ''}
            onInput={(value) => onChange({ ...form, anchor_day: value === '' ? null : value })}
            error={errors.anchor_day}
            disabled={locked}
          />
        </div>
      )}
    </>
  );
}
