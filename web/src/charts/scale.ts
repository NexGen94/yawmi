// Small helpers shared by the charts: clamping a ratio, and the Arabic sentence for a missing
// series. Kept apart from rtl.ts, which only mirrors.

import { fmt } from '../lib/format';

/** A ratio clamped to [0, 1], or undefined when it is not a finite number. */
export function ratio(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** A ratio formatted as a percentage, clamping unfinished (>0 and <1) values to [1%, 99%] so
 *  0.999 never prints «100%» under an unfinished arc. */
export function ratioPct(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value > 0 && value < 1) {
    return fmt.pct(Math.min(0.99, Math.max(0.01, value)));
  }
  return fmt.pct(value);
}

/** "label: 50%", or "label: —" when the ratio is missing. */
export function ratioLabel(label: string, value: number | undefined): string {
  return `${label}: ${ratioPct(value)}`;
}

/** The label of a chart with no data yet. */
export function emptyLabel(label: string): string {
  return `${label}: لا بيانات بعد`;
}
