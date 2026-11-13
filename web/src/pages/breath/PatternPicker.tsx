import { PATTERN_CODES, PATTERNS, type PatternCode } from '../../breath/patterns';
import { cycle } from '../../breath/timing';
import { fmt } from '../../lib/format';
import { Segmented } from '../../ui/Segmented';

export interface PatternPickerProps {
  pattern: PatternCode;
  /** The rate the line under the choice is computed at. */
  rate: number;
  onChange(pattern: PatternCode): void;
}

const seconds = (n: number): string => `${fmt.num(Math.round(n * 10) / 10)} ث`;

/** The six styles, one at a time. Under the choice: how long the inhale and the exhale are at the
 *  rate that is set (no style has a hold phase). */
export function PatternPicker({ pattern, rate, onChange }: PatternPickerProps) {
  const [inhale, exhale] = cycle(pattern, rate);
  return (
    <div class="pattern-picker">
      <Segmented
        label="الأسلوب"
        options={PATTERN_CODES.map((code) => ({ value: code, label: PATTERNS[code].label }))}
        value={pattern}
        onChange={onChange}
      />
      <p class="breath-note num">{`شهيق ${seconds(inhale?.seconds ?? 0)} · زفير ${seconds(exhale?.seconds ?? 0)}`}</p>
    </div>
  );
}
