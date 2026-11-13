import { durationChips, type DurationChoice, type FormErrors, type HabitForm, withDuration, withEnd, withStart } from '../../habits/form';
import { fmt } from '../../lib/format';
import { Field } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { LockedGroup } from './LockedGroup';

type ChipValue = `${(typeof durationChips)[number]}` | 'custom' | 'open';

const OPTIONS: readonly { value: ChipValue; label: string }[] = [
  ...durationChips.map((n) => ({ value: String(n) as ChipValue, label: fmt.count(n, 'day') })),
  { value: 'custom', label: 'مخصص' },
  { value: 'open', label: 'مستمرة' },
];

const chipOf = (choice: DurationChoice): ChipValue => (choice === null ? 'open' : (String(choice) as ChipValue));
const choiceOf = (chip: ChipValue): DurationChoice => (chip === 'open' ? null : chip === 'custom' ? 'custom' : (Number(chip) as DurationChoice));

export interface DateRangeFieldsProps {
  form: HabitForm;
  errors: FormErrors;
  locked: boolean;
  /** Said under a locked field. */
  lockHint?: string;
  onChange(next: HabitForm): void;
}

/** The period of a habit by date, from and to (A5): two date fields, and the chips of the usual
 *  lengths. A chip fills «إلى» from «من»; a typed «إلى» turns the chip into «مخصص»; «مستمرة» empties it. */
export function DateRangeFields({ form, errors, locked, lockHint, onChange }: DateRangeFieldsProps) {
  return (
    <div class="editor-dates">
      <div class="editor-date-pair">
        <Field
          label="من"
          type="date"
          value={form.start_day ?? ''}
          onInput={(value) => onChange(withStart(form, value))}
          error={errors.start_day}
          hint={locked ? lockHint : undefined}
          disabled={locked}
        />
        <Field
          label="إلى"
          type="date"
          value={form.end_day ?? ''}
          onInput={(value) => onChange(withEnd(form, value))}
          error={errors.end_day}
          hint={locked ? lockHint : undefined}
          disabled={locked}
        />
      </div>
      <LockedGroup label="طول الفترة" locked={locked} hint={lockHint}>
        <Segmented
          label="طول الفترة"
          disabled={locked}
          options={OPTIONS}
          value={chipOf(form.duration)}
          onChange={(chip) => onChange(withDuration(form, choiceOf(chip)))}
        />
      </LockedGroup>
    </div>
  );
}
