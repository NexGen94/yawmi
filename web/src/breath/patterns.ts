// The six paced-breathing styles and the limits around them (design 9.5, controller ruling 5).
// Every style is an inhale and an exhale only: no hold phase anywhere. The rate of a style is 5 to
// 6.5 breaths a minute, one of four values. Widening any of this needs a safety review, not an edit
// of a constant; the server refuses a value past these limits too (422 `breath_limit`).

export const PATTERNS = {
  calm: { label: 'تهدئة', inhale: 2, exhale: 3, rate: 6 },
  focus: { label: 'تركيز', inhale: 1, exhale: 1, rate: 6 },
  sleep: { label: 'تهيئة للنوم', inhale: 1, exhale: 2, rate: 5 },
  energize: { label: 'تنشيط الصباح', inhale: 1, exhale: 1, rate: 6.5 },
  unwind: { label: 'بعد العمل', inhale: 2, exhale: 3, rate: 5.5 },
  prepare: { label: 'قبل موقف مهم', inhale: 1, exhale: 2, rate: 6 },
} as const;

export const RATES = [5, 5.5, 6, 6.5] as const;

export type PatternCode = keyof typeof PATTERNS;
export type Rate = (typeof RATES)[number];

/** The two tests are recorded as breath sessions of their own `pattern`. */
export type TestCode = 'exhale_test' | 'hold_test';

/** The exhale-length test stops by itself here (design 9.5). */
export const EXHALE_MAX_SECONDS = 60;
/** The optional breath-hold test stops by itself here (design 9.5, ruling 5). */
export const HOLD_MAX_SECONDS = 30;

/** The shortest and the longest session, in minutes (design 7.3: `breath_prefs.minutes`). */
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 10;
/** What a session lasts until the person chooses otherwise. */
export const DEFAULT_MINUTES = 5;

/** Always on the page, whatever the state of the data. */
export const SAFETY_TEXT =
  'يُوقَف التمرين عند الدوار أو التنميل. لا يُمارَس أثناء القيادة. ومن لديه مرض في القلب أو الرئة، أو حمل، أو اضطراب هلع، يستشير طبيباً.';

/** Above the button of the hold test. */
export const HOLD_NOTE = 'يمكن التوقف في أي لحظة';

export const PATTERN_CODES = Object.keys(PATTERNS) as PatternCode[];

export function isPatternCode(value: unknown): value is PatternCode {
  return typeof value === 'string' && Object.hasOwn(PATTERNS, value);
}

/** The six styles only: the two tests and any code another device wrote are not among them. */
export function isNamedStyle(pattern: string): pattern is PatternCode {
  return isPatternCode(pattern);
}
