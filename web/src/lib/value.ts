// A value shown on a card or in a sentence (a pace, an indicator). A value that is not zero is never
// written «0»: below 1 it keeps two decimals, and below 0.005 it says so in words; from 1 up, one
// decimal. The pace line and the indicators use this one function, so they always agree.

import { fmt } from './format';

export function valueNum(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.005) return 'أقل من 0.01';
  return fmt.num(n, { maximumFractionDigits: Math.abs(n) < 1 ? 2 : 1 });
}

/** A score out of 100 as the ring draws it: a whole number, but never 0 for a ratio above zero and
 *  never 100 for one under 1 (the ring clamps an unfinished arc to 1% to 99%). The sentence, the
 *  card and the ring so always say the same number. */
export function points(ratio: number): number {
  if (ratio > 0 && ratio < 1) return Math.min(99, Math.max(1, Math.round(ratio * 100)));
  return Math.round(ratio * 100);
}
