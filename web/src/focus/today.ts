// What the home page needs from the focus feature, and nothing else: the score, the target, the
// minutes of a day and the sessions still in the outbox, with the words of the score. The page-only
// parts (templates, plant, hours, schedule) live in `calc.ts` and `format.ts`, so that they stay in
// the lazy chunk of the focus page and out of the first load.

import type { components } from '../api/schema';
import type { Day } from '../domain/types';
import { fmt } from '../lib/format';
import { todayRiyadh } from '../lib/today';
import type { OutboxEvent } from '../sync/outbox';

export type FocusSessionOut = components['schemas']['FocusSessionOut'];
export type FocusPlanOut = components['schemas']['FocusPlanOut'];

const MS_PER_MINUTE = 60_000;

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

/** Said when there is no target to measure the minutes against. */
export const NO_TARGET = 'لا هدف يومي للتركيز بعد';

/** «45 من 90 دقيقة · للوعي الذاتي»: what a score stands for. It is an estimate, not a grade. */
export function scoreDetail(minutes: number, target: number): string {
  return `${fmt.num(minutes)} من ${fmt.count(target, 'minute')} · للوعي الذاتي`;
}

/** «50 · 45 من 90 دقيقة · للوعي الذاتي». */
export function scoreLine(score: number, minutes: number, target: number): string {
  return `${fmt.num(score)} · ${scoreDetail(minutes, target)}`;
}
