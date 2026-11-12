import { x } from './rtl';
import { ratio, ratioLabel } from './scale';

export interface ProgressBarProps {
  /** Share done, 0 to 1. Values outside are clamped; a missing value shows an empty track. */
  value: number;
  /** What the bar measures, in Arabic; the accessible name is "label: 25%". */
  label: string;
}

const HEIGHT = 8;

/** A thin horizontal bar that fills from the inline start (the right in RTL). Its width follows
 *  the container: positions are percentages, mirrored through x() in rtl.ts. */
export function ProgressBar({ value, label }: ProgressBarProps) {
  const v = ratio(value);
  const filled = (v ?? 0) * 100;
  return (
    <svg
      class="chart bar"
      role="img"
      aria-label={ratioLabel(label, v)}
      width="100%"
      height={HEIGHT}
      focusable="false"
    >
      <rect class="bar-track" x="0" y="0" width="100%" height={HEIGHT} rx={HEIGHT / 2} />
      <rect
        class="bar-fill"
        x={`${x(filled - 0.5, 100, 100)}%`}
        y="0"
        width={`${filled}%`}
        height={HEIGHT}
        rx={HEIGHT / 2}
      />
    </svg>
  );
}
