import { describe, expect, it } from 'vitest';

import { LOG_WINDOW_DAYS as HOME_WINDOW, logsFrom } from '../../src/habits/todayData';
import { JOURNAL_DAYS, journalFrom, LOG_WINDOW_DAYS, logsFromWeek, yearStart } from '../../src/review/data';
import { fromOrdinal, toOrdinal } from '../../src/domain/days';

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

describe('the start of the journal window (fix round 1, I-1)', () => {
  it('is the first day of the month that holds the day 179 days back', () => {
    expect(journalFrom('2026-11-14')).toBe('2026-05-01');
    expect(journalFrom('2026-11-13')).toBe('2026-05-01');
    expect(journalFrom('2027-01-01')).toBe('2026-07-01');
    expect(journalFrom('2028-03-01')).toBe('2027-09-01');
  });

  it('never starts later than the plain window, and stays inside the 400 days the server allows', () => {
    for (let n = 0; n < 800; n += 1) {
      const day = fromOrdinal(toOrdinal('2026-10-31') + n);
      const from = journalFrom(day);
      const span = toOrdinal(day) - toOrdinal(from) + 1;
      expect(span).toBeGreaterThanOrEqual(JOURNAL_DAYS);
      expect(span).toBeLessThanOrEqual(JOURNAL_DAYS + 30);
      expect(from.endsWith('-01')).toBe(true);
    }
  });
});
