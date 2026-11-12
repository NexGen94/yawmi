import { fmt } from '../../lib/format';
import type { StatusFilterValue } from '../../progress/state';
import { Segmented } from '../../ui/Segmented';

export interface StatusFilterProps {
  value: StatusFilterValue;
  /** How many habits each choice would show, in the current scope. */
  counts: Record<StatusFilterValue, number>;
  onChange(value: StatusFilterValue): void;
}

const WORDS: Record<StatusFilterValue, string> = {
  active: 'فعّالة',
  done: 'منجزة',
  late: 'متأخرة',
  all: 'الكل',
};
const ORDER: readonly StatusFilterValue[] = ['active', 'done', 'late', 'all'];

/** «فعّالة، منجزة، متأخرة، الكل»: one choice of four, each with its count («متأخرة 2»). */
export function StatusFilter({ value, counts, onChange }: StatusFilterProps) {
  const options = ORDER.map((v) => ({ value: v, label: `${WORDS[v]} ${fmt.num(counts[v])}` }));
  return <Segmented label="الحالة" options={options} value={value} onChange={onChange} />;
}
