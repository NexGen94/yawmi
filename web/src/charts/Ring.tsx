import { fmt } from '../lib/format';
import { flip } from './rtl';
import { ratio, ratioLabel } from './scale';

export interface RingProps {
  /** Share done, 0 to 1. Values outside are clamped; a missing value shows a dash. */
  value: number;
  /** What the ring measures, in Arabic; the accessible name is "label: 50%". */
  label: string;
  /** Outer size in pixels (default 120). */
  size?: number;
}

/** A progress ring: one number in the middle, the arc filling from the top in the reading
 *  direction (counter-clockwise, because the page reads from the right). */
export function Ring({ value, label, size = 120 }: RingProps) {
  const v = ratio(value);
  const stroke = Math.max(6, Math.round(size / 12));
  const c = size / 2;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = (v ?? 0) * circumference;
  // Start at 12 o'clock (rotate), then mirror horizontally through rtl.ts so the arc runs towards
  // the inline end. The transform applies right to left: rotate first, then x -> flip(x, size).
  const toReadingDirection = `translate(${flip(0, size)} 0) scale(-1 1) rotate(-90 ${c} ${c})`;

  return (
    <svg
      class="chart ring"
      role="img"
      aria-label={ratioLabel(label, v)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      focusable="false"
    >
      <circle class="ring-track" cx={c} cy={c} r={r} fill="none" stroke-width={stroke} />
      <circle
        class={dash > 0 ? 'ring-arc ring-arc-on' : 'ring-arc'}
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke-width={stroke}
        stroke-dasharray={`${dash} ${circumference}`}
        transform={toReadingDirection}
      />
      <text
        class="ring-value"
        x={c}
        y={c}
        text-anchor="middle"
        dominant-baseline="central"
        font-size={Math.round(size * 0.22)}
      >
        {v === undefined ? '—' : fmt.pct(v)}
      </text>
    </svg>
  );
}
