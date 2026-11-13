// The calculations of the focus page (design 9.5). Pure: no clock, no storage, no network.

import type { components } from '../api/schema';
import type { Day } from '../domain/types';
import { todayRiyadh } from '../lib/today';
import type { OutboxEvent } from '../sync/outbox';

export type FocusSessionOut = components['schemas']['FocusSessionOut'];
export type FocusPlanOut = components['schemas']['FocusPlanOut'];

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

/** The daily focus score: `round(100 × min(1, minutes ÷ target))`, or null without a target. */
export function focusScore(minutesToday: number, target: number | null): number | null {
  if (target === null || !(target > 0)) return null;
  return Math.round(100 * Math.min(1, Math.max(0, minutesToday) / target));
}

/** The target the score is measured against: the minutes planned in the morning journal, else the
 *  setting `focus_daily_target_min`, else none (the page then says so; no number is made up). */
export function focusTarget(
  plannedInMorning: number | null | undefined,
  dailySetting: number | null | undefined,
): number | null {
  if (typeof plannedInMorning === 'number' && plannedInMorning > 0) return plannedInMorning;
  if (typeof dailySetting === 'number' && dailySetting > 0) return dailySetting;
  return null;
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

/** The actual minutes of the sessions of one Riyadh day. */
export function minutesOn(sessions: FocusSessionOut[], day: Day): number {
  return sessions.filter((s) => s.day === day).reduce((sum, s) => sum + (s.actual_minutes ?? 0), 0);
}

/**
 * The sessions of the server with the `focus_ended` events still in the outbox laid over them, so
 * the score and the hours move the moment a session is saved. A session is built the way the
 * server builds it: the payload's start and end, else the event time and the actual length.
 */
export function applyPendingFocus(sessions: FocusSessionOut[], events: OutboxEvent[]): FocusSessionOut[] {
  const known = new Set(sessions.map((s) => s.id));
  const out = [...sessions];
  for (const event of events) {
    if (event.type !== 'focus_ended' || known.has(event.id)) continue;
    const p = event.payload as {
      started_at?: string | null;
      ended_at?: string | null;
      planned_minutes?: number | null;
      actual_minutes?: number | null;
      goal_ref?: string | null;
      habit_code?: string | null;
      focus_rating?: number | null;
      next_step?: string | null;
    };
    const endMs = Date.parse(p.ended_at ?? event.occurred_at);
    if (!Number.isFinite(endMs)) continue;
    const spanMs = typeof p.actual_minutes === 'number' ? p.actual_minutes * MS_PER_MINUTE : 0;
    const startMs = p.started_at ? Date.parse(p.started_at) : endMs - spanMs;
    if (!Number.isFinite(startMs) || startMs > endMs) continue;
    out.push({
      id: event.id,
      day: todayRiyadh(new Date(startMs)),
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(endMs).toISOString(),
      planned_minutes: p.planned_minutes ?? null,
      actual_minutes: p.actual_minutes ?? null,
      goal_ref: p.goal_ref ?? null,
      habit_code: p.habit_code ?? null,
      focus_rating: p.focus_rating ?? null,
      next_step: p.next_step ?? null,
    });
  }
  return out;
}
