import { fmt } from '../lib/format';
import { x } from './rtl';
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
  const c = x(0, 1, size);
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = (v ?? 0) * circumference;
  // Start at 12 o'clock (rotate), then mirror horizontally through x() in rtl.ts so the arc runs
  // towards the inline end.
  const toReadingDirection = `translate(${x(-0.5, 1, size)} 0) scale(-1 1) rotate(-90 ${c} ${c})`;

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
        direction="rtl"
        text-anchor="middle"
        dominant-baseline="central"
        font-size={Math.round(size * 0.22)}
      >
        {v === undefined ? '—' : fmt.pct(v)}
      </text>
    </svg>
  );
}
