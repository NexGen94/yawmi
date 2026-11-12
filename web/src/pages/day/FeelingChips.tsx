import { fmt } from '../../lib/format';
import { Chips } from '../../ui/Chips';
import { FEELINGS } from './feelings';
import { LIMITS } from './limits';

export interface FeelingChipsProps {
  selected: readonly string[];
  onChange(next: string[]): void;
}

const OPTIONS = FEELINGS.map((f) => ({ value: f.code, label: f.label }));

/** The twelve feelings as toggles, at most six at once: at the limit the page says so, and a
 *  seventh tap changes nothing until one is cleared. */
export function FeelingChips({ selected, onChange }: FeelingChipsProps) {
  return (
    <>
      <Chips
        label="المشاعر"
        options={OPTIONS}
        selected={selected}
        onChange={(next) => {
          if (next.length > LIMITS.feelings) return;
          onChange(next);
        }}
      />
      {selected.length >= LIMITS.feelings && <p class="day-note">{`حتى ${fmt.num(LIMITS.feelings)} مشاعر`}</p>}
    </>
  );
}
