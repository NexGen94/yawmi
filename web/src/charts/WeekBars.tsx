import { fmt } from '../lib/format';
import { x } from './rtl';
import { emptyLabel } from './scale';

export interface WeekBarsProps {
  /** One value per period, oldest first. The oldest sits at the inline start (the right). */
  values: number[];
  /** What the bars count, in Arabic. */
  label: string;
}

const W = 320;
const H = 120;
const TOP = 22; // room for the number over the latest bar
const BASE = H - 2; // the baseline, with room for its hairline

/** Bars for the last periods. Only the latest bar carries its number; each bar has a tooltip
 *  (title) with its own value. */
export function WeekBars({ values, label }: WeekBarsProps) {
  const vals = values.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  const n = vals.length;
  if (n === 0) {
    return (
      <svg class="chart bars" role="img" aria-label={emptyLabel(label)} viewBox={`0 0 ${W} ${H}`} focusable="false">
        <line class="bars-base" x1="0" y1={BASE} x2={W} y2={BASE} />
      </svg>
    );
  }

  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const last = vals[n - 1] ?? 0;
  const bar = Math.min(24, (W / n) * 0.6);
  // A zero still draws a 2px stub on the baseline, so its slot is visible.
  const heightOf = (v: number): number => (max > 0 ? Math.max(2, (v / max) * (BASE - TOP)) : 2);
  const sentence = `${label}: الأحدث ${fmt.num(last)}، والأعلى ${fmt.num(max)}، والأدنى ${fmt.num(min)}`;

  return (
    <svg class="chart bars" role="img" aria-label={sentence} viewBox={`0 0 ${W} ${H}`} focusable="false">
      <line class="bars-base" x1="0" y1={BASE} x2={W} y2={BASE} />
      {vals.map((v, i) => {
        const h = heightOf(v);
        const slotX = x(i, n, W);
        return (
          <rect
            key={slotX}
            class={i === n - 1 ? 'bars-bar bars-latest' : 'bars-bar'}
            x={slotX - bar / 2}
            y={BASE - h}
            width={bar}
            height={h}
            rx={Math.min(4, bar / 2)}
          >
            <title>{fmt.num(v)}</title>
          </rect>
        );
      })}
      <text class="bars-value" x={x(n - 1, n, W)} y={BASE - heightOf(last) - 6} direction="rtl" text-anchor="middle">
        {fmt.num(last)}
      </text>
    </svg>
  );
}
