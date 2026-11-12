import { Chips } from '../../ui/Chips';
import { FEELINGS, MAX_FEELINGS } from './feelings';

export interface FeelingChipsProps {
  selected: readonly string[];
  onChange(next: string[]): void;
}

const OPTIONS = FEELINGS.map((f) => ({ value: f.code, label: f.label }));

/** The twelve feelings as toggles, at most six at once: a seventh tap changes nothing. */
export function FeelingChips({ selected, onChange }: FeelingChipsProps) {
  return (
    <Chips
      label="المشاعر"
      options={OPTIONS}
      selected={selected}
      onChange={(next) => {
        if (next.length > MAX_FEELINGS) return;
        onChange(next);
      }}
    />
  );
}
