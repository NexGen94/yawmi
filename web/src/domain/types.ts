// Inputs and outputs of the habit rules (spec 2.6). The Python module `api/yawmi/domain/` is the
// reference implementation; these are the same shapes with camelCase field names, and the shared
// vectors in `contracts/domain-vectors/v1/` prove both agree.
//
// `HabitSpec` is deliberately not `HabitIn`/`HabitOut` from `../habits/types` (the generated API
// shapes: snake_case, a title, reminders, a `start_day` the server may fill in), but the rule
// input, where `startDay` is always known. `habitSpecOf` in `../habits/spec` converts one into the
// other. The enum types are the generated ones.

import type { HabitKind, HabitPeriod, HabitUnit, ScheduleKind } from '../habits/types';

export type { HabitKind, HabitUnit, ScheduleKind };
export type Period = HabitPeriod;

/** The rules version these modules implement; must equal `rulesVersion` in the vector files. */
export const RULES_VERSION = 2;

/** A calendar day, `YYYY-MM-DD`. Always computed in pure UTC, never in the browser's zone. */
export type Day = string;

export type WeekStart = 'sat' | 'sun' | 'mon';

export type LogStatus = 'done' | 'skip' | 'vacation' | 'missed';

/** `abstain` (rulesVersion 2, design 9.6): a `done` log is a slip; see `../domain/habits`. */
export type Polarity = 'build' | 'abstain';

export interface HabitSpec {
  kind: HabitKind;
  /**
   * Display unit only; the rules never read it. The API spells "no unit" `''`; `null` is kept
   * because the Python reference (`str | None`) and the shared vectors use it.
   */
  unit: HabitUnit | null;
  /** In the habit's unit, greater than zero. */
  targetPerPeriod: number;
  period: Period;
  /** Weekly and monthly habits accept `every_day` only. */
  scheduleKind: ScheduleKind;
  /** Bit 0 = Sunday ... bit 6 = Saturday; required (1..127) for `weekdays`. */
  weekdayMask: number | null;
  /** Required (>= 2, like the server and the database) for `every_n_days`, with `anchorDay`. */
  everyN: number | null;
  anchorDay: Day | null;
  startDay: Day;
  /** Last day of a challenge; `null` for an open habit. */
  endDay: Day | null;
  /**
   * `build` when missing. An `abstain` habit is a daily boolean with target 1 whose `done` log is
   * a slip: every scheduled day up to and including today is kept unless a slip is logged.
   */
  polarity?: Polarity;
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
