import { describe, expect, it } from 'vitest';

import { valueText } from '../../src/pages/goals/EditLog';

describe('valueText of the edit log (Task 24)', () => {
  it('writes a day as a date in words, not as «2026-11-12»', () => {
    expect(valueText('2026-11-12')).toBe('الخميس، 12 نوفمبر 2026');
  });

  it('keeps the other values as they were', () => {
    expect(valueText(true)).toBe('منجزة');
    expect(valueText(false)).toBe('مفتوحة');
    expect(valueText('دليل')).toBe('دليل');
    expect(valueText(null)).toBe('—');
    expect(valueText('')).toBe('—');
  });
});
