// Inputs and outputs of the habit rules (spec 2.6). The Python module `api/yawmi/domain/` is the
// reference implementation; these are the same shapes with camelCase field names, and the shared
// vectors in `contracts/domain-vectors/v1/` prove both agree.
//
// `HabitSpec` is deliberately not `HabitIn` from `../habits/types`: that one is the API/form
// payload (snake_case, a title, reminders, a nullable `start_day` the server fills in), while this
// is the rule input, where `startDay` is always known. The enum types are shared.

import type { HabitKind, HabitPeriod, ScheduleKind } from '../habits/types';

export type { HabitKind, ScheduleKind };
export type Period = HabitPeriod;

/** The rules version these modules implement; must equal `rulesVersion` in the vector files. */
export const RULES_VERSION = 1;

/** A calendar day, `YYYY-MM-DD`. Always computed in pure UTC, never in the browser's zone. */
export type Day = string;

export type WeekStart = 'sat' | 'sun' | 'mon';

export type LogStatus = 'done' | 'skip' | 'vacation' | 'missed';

export interface HabitSpec {
  kind: HabitKind;
  /** Display unit only; the rules never read it. */
  unit: string | null;
  /** In the habit's unit, greater than zero. */
  targetPerPeriod: number;
  period: Period;
  /** Weekly and monthly habits accept `every_day` only. */
  scheduleKind: ScheduleKind;
  /** Bit 0 = Sunday ... bit 6 = Saturday; required (1..127) for `weekdays`. */
  weekdayMask: number | null;
  /** Required (>= 1) for `every_n_days`, with `anchorDay`. */
  everyN: number | null;
  anchorDay: Day | null;
  startDay: Day;
  /** Last day of a challenge; `null` for an open habit. */
  endDay: Day | null;
}

export interface HabitLog {
  day: Day;
  /** Ignored unless `status` is `done`. */
  value: number | null;
  status: LogStatus;
}

export interface PeriodBounds {
  start: Day;
  end: Day;
}

export interface PeriodProgress {
  done: number;
  target: number;
  completion: number;
  reached: boolean;
  expected: number;
  onTrack: boolean;
  needPerDay: number;
}

export interface ChallengeProgress {
  achieved: number;
  total: number;
  completion: number;
  remainingDays: number;
}
