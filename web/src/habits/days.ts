// The days of the week as the reminders and schedules masks have them: bit 0 is Sunday and bit 6
// is Saturday (the plan week starts on Sunday).

export const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;

/** Every day of the week. */
export const ALL_DAYS = 0b1111111;

/** The days of a reminder in a few words: «كل يوم» or the names. */
export function daysWord(mask: number): string {
  if (mask === ALL_DAYS) return 'كل يوم';
  return namesOf(mask).join('، ') || 'لا يوم';
}

/** The names of the days a mask holds. */
export function namesOf(mask: number | null): string[] {
  return WEEKDAYS.filter((_, bit) => ((mask ?? 0) >> bit) & 1);
}

/** The mask of the days with the given names. */
export function maskOf(names: readonly string[]): number {
  return WEEKDAYS.reduce((mask, name, bit) => (names.includes(name) ? mask | (1 << bit) : mask), 0);
}
