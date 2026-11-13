import type { components } from '../../api/schema';
import { fmt } from '../../lib/format';
import { Segmented } from '../../ui/Segmented';

export type AskRange = components['schemas']['AskRequest']['range'];

export interface RangeChipsProps {
  value: AskRange;
  onChange(range: AskRange): void;
  disabled?: boolean;
}

/** The range of days the answer reads (feature 22): 7 days, 30 days, or the current cycle. */
export function RangeChips({ value, onChange, disabled }: RangeChipsProps) {
  const options: { value: AskRange; label: string }[] = [
    { value: '7d', label: fmt.count(7, 'day') },
    { value: '30d', label: fmt.count(30, 'day') },
    { value: 'cycle', label: 'الدورة' },
  ];
  return <Segmented label="المدى" options={options} value={value} onChange={onChange} disabled={disabled} />;
}
