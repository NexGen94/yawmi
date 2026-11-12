import { fmt } from '../../lib/format';
import { Field } from '../../ui/Field';
import { LIMITS } from './limits';

export interface GratitudeFieldsProps {
  /** Always three entries; empty ones are dropped when the journal is saved. */
  values: readonly string[];
  onChange(next: string[]): void;
}

/** Up to three short lines of gratitude, all optional (`gratitude` allows three of 200 characters, see limits.ts). */
export function GratitudeFields({ values, onChange }: GratitudeFieldsProps) {
  return (
    <div class="day-gratitude">
      {[0, 1, 2].map((i) => (
        <Field
          key={i}
          label={`الامتنان ${fmt.num(i + 1)}`}
          value={values[i] ?? ''}
          maxLength={LIMITS.gratitude}
          onInput={(text) => onChange([0, 1, 2].map((j) => (j === i ? text : (values[j] ?? ''))))}
        />
      ))}
    </div>
  );
}
