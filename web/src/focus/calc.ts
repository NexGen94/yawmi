// The calculations of the focus page (design 9.5). Pure: no clock, no storage, no network.

import type { FocusSessionOut } from './today';

// The calculations the home page also uses are in `today.ts` (first load); they are named here too.
export { applyPendingFocus, type FocusPlanOut, focusScore, focusTarget, type FocusSessionOut, minutesOn } from './today';

/** The two ready plans a person can create with one tap (design 4: «قوالب جاهزة»). */
export const FOCUS_TEMPLATES = [
  { title: 'جلسة صباحية', minutes: 25 },
  { title: 'عمل عميق', minutes: 90 },
] as const;

/** The three durations offered as a preference, not a rule (design 4). */
export const PRESET_MINUTES = [25, 50, 90] as const;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const RIYADH_OFFSET_MS = 3 * MS_PER_HOUR;

/** Stage of the growing plant, 0 to 4: `min(4, floor(5 × elapsed ÷ planned))`. Stopping keeps the
 *  stage reached. A missing plan or a negative or unreadable time stays at 0. */
export function plantStage(elapsed: number, planned: number): 0 | 1 | 2 | 3 | 4 {
  if (!(planned > 0) || !(elapsed > 0)) return 0;
  return Math.min(4, Math.floor((5 * elapsed) / planned)) as 0 | 1 | 2 | 3 | 4;
}

/** Minutes of focus for each of the 24 hours of the Riyadh day, from `started_at` to `ended_at`
 *  of every ended session: 09:40 to 10:30 gives 20 for hour 9 and 30 for hour 10. */
export function hourBins(sessions: FocusSessionOut[]): number[] {
  const bins = Array.from({ length: 24 }, () => 0);
  for (const s of sessions) {
    if (s.ended_at === null) continue;
    const start = Date.parse(s.started_at);
    const end = Date.parse(s.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    let cursor = start;
    while (cursor < end) {
      const local = cursor + RIYADH_OFFSET_MS;
      const hour = Math.floor((local % (24 * MS_PER_HOUR)) / MS_PER_HOUR);
      const hourEnd = cursor + (MS_PER_HOUR - (local % MS_PER_HOUR));
      const slice = Math.min(end, hourEnd) - cursor;
      bins[hour] = (bins[hour] ?? 0) + slice / MS_PER_MINUTE;
      cursor += slice;
    }
  }
  // Float noise from dividing milliseconds: minutes are shown whole.
  return bins.map((v) => Math.round(v * 1000) / 1000);
}

/** The hour with the most minutes (the earliest on a tie), or null when nothing was recorded. */
export function topHour(bins: number[]): { hour: number; minutes: number } | null {
  let best = -1;
  let hour = 0;
  bins.forEach((minutes, i) => {
    if (minutes > best) {
      best = minutes;
      hour = i;
    }
  });
  return best > 0 ? { hour, minutes: best } : null;
}
