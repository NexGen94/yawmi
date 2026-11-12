// The habit API types, taken from the generated schema (openapi/openapi.json via `npm run gen:api`).
// The server is the authority on their shape: `title_ar`, `unit: ''` for "no unit", reminders as
// `{time: 'HH:mm', days_mask}`, `ac_ref` next to `goal_ref`. Nothing here is written by hand
// except the short names.
//
// Note on `HabitIn`: fields with a server default (`unit`, `anchor`, `schedule_kind`) come out as
// required in the generated type; the editor always sends them, so that costs nothing.

import type { components } from '../api/schema';

type Schemas = components['schemas'];

/** `POST /v1/habits` body. */
export type HabitIn = Schemas['HabitIn'];
/** A stored habit, as `GET /v1/habits` returns it (`start_day` always set). */
export type HabitOut = Schemas['HabitOut'];
/** Unsaved suggestion returned by `POST /v1/goals/{ref}/to-habit`: every field set, `goal_ref` a string. */
export type HabitDraft = Schemas['HabitDraft'];
/** `PATCH /v1/habits/{code}` body: only the fields sent change. */
export type HabitPatch = Schemas['HabitPatch'];
export type ReminderIn = Schemas['ReminderIO'];

export type HabitKind = HabitOut['kind'];
export type HabitUnit = HabitOut['unit'];
export type HabitPeriod = HabitOut['period'];
export type ScheduleKind = HabitOut['schedule_kind'];
export type HabitAnchor = HabitOut['anchor'];
export type HabitCreator = HabitOut['created_by'];
export type HabitPolarity = HabitOut['polarity'];
