// What the pace of an outcome is measured on: the same rule as the server's (`load_pace` in
// api/yawmi/goals/service.py, design 9.4), so the home page never says what the goal page denies.
// A cumulative KPI of the outcome with a positive target is the basis (the first by code); every
// other outcome is paced on its milestones, from the plan's start. The readings come from the plan
// itself (`kpis[].latest`), so there is no request per goal.

import { toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import { type GoalOutcome, PLAN_START } from './types';

/** The KPIs whose target is a total reached by the due day (`CUMULATIVE_KPIS` of the server). */
export const CUMULATIVE_KPIS: ReadonlySet<string> = new Set(['measured_projects', 'workshops_count', 'books_done']);
/** The yearly total: its line is the current calendar year's. */
const YEARLY_KPI = 'books_done';

export interface PaceBasis {
  start: Day;
  due: Day;
  /** Where the outcome stands; `null` when there is nothing to measure yet (it is then not judged). */
  current: number | null;
  target: number;
}

/** The first and last day of the line of the yearly KPI: from 1 January (the plan start in 2026) to 31 December. */
function yearSpan(today: Day): [Day, Day] {
  const year = today.slice(0, 4);
  const january = `${year}-01-01`;
  return [january > PLAN_START ? january : PLAN_START, `${year}-12-31`];
}

export function paceBasis(outcome: GoalOutcome, today: Day): PaceBasis {
  const usable = outcome.kpis
    .filter((k) => k.target !== null && Number.isFinite(k.target) && k.target > 0 && CUMULATIVE_KPIS.has(k.code))
    .sort((a, b) => a.code.localeCompare(b.code));
  const chosen = usable[0];
  if (chosen === undefined || chosen.target === null) {
    const total = outcome.milestones_total;
    return {
      start: PLAN_START,
      due: outcome.target_date,
      current: total > 0 ? outcome.milestones_done : null,
      target: total,
    };
  }
  const [start, due] = chosen.code === YEARLY_KPI ? yearSpan(today) : [PLAN_START, outcome.target_date];
  const latest = chosen.latest;
  // the server reads the readings of the line itself: one before its start is not one
  const reading = latest !== null && latest.day >= start && toOrdinal(latest.day) <= toOrdinal(today) ? latest.value : null;
  return { start, due, current: reading, target: chosen.target };
}

