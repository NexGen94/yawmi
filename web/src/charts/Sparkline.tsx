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
  const vals = values.filter((v) => Number.isFinite(v));
  const n = vals.length;
  if (n === 0) {
    return (
      <svg class="chart spark" role="img" aria-label={emptyLabel(label)} viewBox={`0 0 ${W} ${H}`} focusable="false" />
    );
  }
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = max - min;
  const yOf = (v: number): number => (span === 0 ? H / 2 : PAD + (1 - (v - min) / span) * (H - 2 * PAD));
  const points = vals.map((v, i) => `${x(i, n, W)},${yOf(v)}`).join(' ');
  const first = vals[0] ?? 0;
  const last = vals[n - 1] ?? 0;

  return (
    <svg
      class="chart spark"
      role="img"
      aria-label={`${label}: من ${fmt.num(first)} إلى ${fmt.num(last)}`}
      viewBox={`0 0 ${W} ${H}`}
      focusable="false"
    >
      <polyline class="spark-line" fill="none" points={points} />
      <circle class="spark-dot" cx={x(n - 1, n, W)} cy={yOf(last)} r="4" />
    </svg>
  );
}
