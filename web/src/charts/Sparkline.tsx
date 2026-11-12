import { fmt } from '../lib/format';
import { x } from './rtl';
import { emptyLabel } from './scale';

export interface SparklineProps {
  /** The series, oldest first. The oldest point sits at the inline start (the right). */
  values: number[];
  /** What the line follows, in Arabic. */
  label: string;
}

const W = 160;
const H = 40;
const PAD = 5;

/** A small 2px line with a dot on the latest value. Its sentence names the first and last value. */
export function Sparkline({ values, label }: SparklineProps) {
  const n = values.length;
  const entries = values
    .map((v, i) => ({ v, i }))
    .filter((item) => Number.isFinite(item.v));
  if (entries.length === 0) {
    return (
      <svg class="chart spark" role="img" aria-label={emptyLabel(label)} viewBox={`0 0 ${W} ${H}`} focusable="false" />
    );
  }
  const finite = entries.map((e) => e.v);
  const max = Math.max(...finite);
  const min = Math.min(...finite);
  const span = max - min;
  const yOf = (v: number): number => (span === 0 ? H / 2 : PAD + (1 - (v - min) / span) * (H - 2 * PAD));
  const points = entries.map(({ v, i }) => `${x(i, n, W)},${yOf(v)}`).join(' ');
  const first = entries[0]?.v ?? 0;
  const lastEntry = entries.at(-1) ?? { v: 0, i: n - 1 };

  return (
    <svg
      class="chart spark"
      role="img"
      aria-label={`${label}: من ${fmt.num(first)} إلى ${fmt.num(lastEntry.v)}`}
      viewBox={`0 0 ${W} ${H}`}
      focusable="false"
    >
      <polyline class="spark-line" fill="none" points={points} />
      <circle class="spark-dot" cx={x(lastEntry.i, n, W)} cy={yOf(lastEntry.v)} r="4" />
    </svg>
  );
}
