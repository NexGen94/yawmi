import { afterEach, describe, expect, it } from 'vitest';

import { fmt, setDigits, type Noun } from '../../src/lib/format';

afterEach(() => setDigits('latn'));

describe('fmt.count: number and counted noun in Arabic grammar', () => {
  it.each<[number, Noun, string]>([
    [1, 'day', 'يوم'],
    [2, 'day', 'يومان'],
    [3, 'day', '3 أيام'],
    [10, 'day', '10 أيام'],
    [11, 'day', '11 يوماً'],
    [12, 'day', '12 يوماً'],
    [100, 'day', '100 يوماً'],
    [102, 'day', '102 يوماً'],
    [103, 'day', '103 أيام'],
    [111, 'day', '111 يوماً'],
    [0, 'day', '0 أيام'],
    [3, 'session', '3 جلسات'],
    [2, 'time', 'مرتان'],
    [2, 'hour', 'ساعتان'],
    [3, 'item', '3 بنود'],
    [1, 'item', 'بند واحد'],
    [2, 'item', 'بندان'],
    [11, 'item', '11 بنداً'],
    [42, 'second', '42 ث'],
    [200, 'minute', '200 دقيقة'],
    [5, 'minute', '5 دقائق'],
    [2, 'minute', 'دقيقتان'],
    [3, 'milestone', '3 محطات'],
    [2, 'milestone', 'محطتان'],
    [12, 'milestone', '12 محطة'],
  ])('count(%d, %s) is %s', (n, noun, expected) => {
    expect(fmt.count(n, noun)).toBe(expected);
  });

  it('takes the digits setting for the number part', () => {
    setDigits('arab');
    expect(fmt.count(3, 'day')).toBe('٣ أيام');
    expect(fmt.count(42, 'second')).toBe('٤٢ ث');
  });
});

describe('fmt.num and fmt.pct', () => {
  it('uses Latin digits by default and groups thousands', () => {
    expect(fmt.num(12)).toBe('12');
    expect(fmt.num(1234567)).toBe('1,234,567');
  });

  it('passes Intl options through', () => {
    expect(fmt.num(1.5, { minimumFractionDigits: 2 })).toBe('1.50');
  });

  it('switches to Arabic-Indic digits with setDigits("arab")', () => {
    setDigits('arab');
    expect(fmt.num(12)).toBe('١٢');
    setDigits('latn');
    expect(fmt.num(12)).toBe('12');
  });

  it('formats a ratio as a whole percentage', () => {
    expect(fmt.pct(0.5)).toContain('50');
    expect(fmt.pct(0.256)).toContain('26');
    expect(fmt.pct(1)).toContain('100');
    expect(fmt.pct(0)).toContain('0');
  });

  it('shows a dash instead of NaN for a missing ratio', () => {
    expect(fmt.pct(Number.NaN)).toBe('—');
    expect(fmt.pct(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('follows the digits setting for the percentage', () => {
    setDigits('arab');
    expect(fmt.pct(0.5)).toContain('٥٠');
  });
});

describe('fmt.day and fmt.hijri', () => {
  it('writes the Gregorian day with its weekday in Arabic, from the ISO date alone', () => {
    // 2026-11-10 is a Tuesday (the date the mock-up uses); the zone of the machine must not matter.
    const text = fmt.day('2026-11-10');
    expect(text).toContain('الثلاثاء');
    expect(text).toContain('10');
    expect(text).toContain('نوفمبر');
    expect(text).toContain('2026');
  });

  it('keeps the Gregorian calendar even though the locale defaults to Umm al-Qura', () => {
    expect(fmt.day('2031-12-31')).toContain('ديسمبر');
    expect(fmt.day('2031-12-31')).toContain('2031');
  });

  it('writes the Umm al-Qura date', () => {
    const text = fmt.hijri('2031-12-31');
    expect(text).toContain('رمضان');
    expect(text).toContain('1453');
  });

  it('takes the digits setting', () => {
    setDigits('arab');
    expect(fmt.day('2026-11-10')).toContain('١٠');
    expect(fmt.hijri('2031-12-31')).toContain('١٤٥٣');
  });
});
