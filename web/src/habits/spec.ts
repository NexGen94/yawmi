// From the API habit shapes to the rule input of `../domain`. The server does the same in
// `spec_of` (api/yawmi/habits/progress.py): fields one to one, the unit passed through as stored.

import { checkHabitSpec } from '../domain/periods';
import type { Day, HabitSpec } from '../domain/types';
import type { HabitIn, HabitOut } from './types';

/** The fields the rules read. Optional ones may be missing on a habit that is not saved yet. */
export type HabitSpecSource = Pick<HabitOut, 'kind' | 'unit' | 'target_per_period' | 'period' | 'schedule_kind'> &
  Partial<Pick<HabitIn, 'weekday_mask' | 'every_n' | 'anchor_day' | 'start_day' | 'end_day' | 'polarity'>>;

/**
 * The rule input for a stored habit (`HabitOut`, whose `start_day` the server always sets), a draft,
 * or a habit being edited (`HabitIn`).
 *
 * A missing or null `start_day` exists only before saving, and means what the server makes of it on
 * save: today in Riyadh. The caller supplies that day as `today` (`dayKey(new Date())`); without it
 * the start is unknown and this throws `RangeError`, rather than guessing a day the rules would then
 * count from. Also throws `RangeError` for any spec the rules refuse (`checkHabitSpec`), such as
 * `every_n` 1.
 */
export function habitSpecOf(h: HabitSpecSource, today?: Day): HabitSpec {
  const startDay = h.start_day ?? today;
  if (startDay === undefined) throw new RangeError('the habit has no start day and no today was given');
  const spec: HabitSpec = {
    kind: h.kind,
    unit: h.unit,
    targetPerPeriod: h.target_per_period,
    period: h.period,
    scheduleKind: h.schedule_kind,
    weekdayMask: h.weekday_mask ?? null,
    everyN: h.every_n ?? null,
    anchorDay: h.anchor_day ?? null,
    startDay,
    endDay: h.end_day ?? null,
  };
  // The rules read a missing polarity as build, so only an abstain habit carries the field.
  if (h.polarity === 'abstain') spec.polarity = 'abstain';
  checkHabitSpec(spec);
  return spec;
}
