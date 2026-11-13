// The goals models, as the server's generated contract names them (design section 7.4).
import type { components } from '../api/schema';

type Schemas = components['schemas'];
export type GoalsOut = Schemas['GoalsOut'];
export type GoalOutcome = Schemas['GoalOutcome'];
export type MilestoneFull = Schemas['MilestoneFull'];
export type CardFull = Schemas['CardFull'];
export type CycleOut = Schemas['CycleOut'];
export type GoalIndicatorValue = Schemas['GoalIndicatorValue'];
export type GoalColumnsIO = Schemas['GoalColumnsIO'];
export type SettingsOut = Schemas['SettingsOut'];
export type PaceOut = Schemas['PaceOut'];
export type GoalTaskOut = Schemas['GoalTaskOut'];
export type GoalEditOut = Schemas['GoalEditOut'];
export type CardHabit = Schemas['CardHabit'];

/** The plan ends here (design 4.1, the «الخطة» line). */
export const PLAN_END = '2031-12-31';
/** The plan starts here (D-043); the first point of the timeline. */
export const PLAN_START = '2026-10-31';
