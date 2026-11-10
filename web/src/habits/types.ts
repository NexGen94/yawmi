// Hand-written stand-ins for the habit API types (spec 2.6). They will be replaced by the
// generated OpenAPI types in task 16b; the field names follow the spec unified model.

export type HabitKind = 'boolean' | 'count' | 'duration';
export type HabitUnit = '' | 'session' | 'min' | 'hour';
export type HabitPeriod = 'day' | 'week' | 'month';
export type ScheduleKind = 'every_day' | 'weekdays' | 'every_n_days';
export type HabitAnchor = 'after_wake' | 'before_sleep' | 'free';
export type HabitCreator = 'user' | 'seed' | 'goal';

export interface ReminderIn {
  /** Local time of day, `HH:mm`. */
  time: string;
  /** Bit mask of days (1..127). */
  days_mask: number;
}

export interface HabitIn {
  title: string;
  goal_ref: string | null;
  outcome: string | null;
  kind: HabitKind;
  unit: HabitUnit;
  period: HabitPeriod;
  target_per_period: number;
  schedule_kind: ScheduleKind;
  weekday_mask: number | null;
  every_n: number | null;
  /** ISO dates (`YYYY-MM-DD`). */
  anchor_day: string | null;
  start_day: string | null;
  end_day: string | null;
  anchor: HabitAnchor;
  reminders: ReminderIn[];
}

export interface HabitOut extends HabitIn {
  code: string;
  system: boolean;
  created_by: HabitCreator;
  active: boolean;
}

/** Unsaved suggestion returned by `POST /v1/goals/{ref}/to-habit`. */
export type HabitDraft = Partial<HabitIn> & Pick<HabitIn, 'title' | 'kind' | 'period' | 'target_per_period'>;
