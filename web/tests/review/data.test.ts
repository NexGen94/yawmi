import { describe, expect, it } from 'vitest';

import { LOG_WINDOW_DAYS as HOME_WINDOW, logsFrom } from '../../src/habits/todayData';
import { LOG_WINDOW_DAYS, logsFromWeek, yearStart } from '../../src/review/data';

// The week tab keeps its own copy of the 62-day window (importing it would split the rule modules out
// of the first-load chunk): this keeps the copy equal to the one the home page reads.
describe('the log window of the week tab', () => {
  it('is the window of the home page', () => {
    expect(LOG_WINDOW_DAYS).toBe(HOME_WINDOW);
    for (const day of ['2026-11-14', '2027-03-01', '2028-03-01']) expect(logsFromWeek(day)).toBe(logsFrom(day));
  });

  it('the mood tab starts on the first of January of the year of the day', () => {
    expect(yearStart('2026-11-14')).toBe('2026-01-01');
    expect(yearStart('2027-01-01')).toBe('2027-01-01');
  });
});
