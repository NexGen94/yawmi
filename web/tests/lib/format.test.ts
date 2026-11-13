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
    [99, 'day', '99 يوماً'],
    [100, 'day', '100 يوم'],
    [101, 'day', '101 يوم'],
    [102, 'day', '102 يوم'],
    [103, 'day', '103 أيام'],
    [110, 'day', '110 أيام'],
    [111, 'day', '111 يوماً'],
    [200, 'day', '200 يوم'],
    [0, 'day', '0 أيام'],
    [1000, 'item', '1,000 بند'],
    [1001, 'item', '1,001 بند'],
    [1002, 'item', '1,002 بند'],
    [1003, 'item', '1,003 بنود'],
    [10, 'item', '10 بنود'],
    [11, 'item', '11 بنداً'],
    [99, 'item', '99 بنداً'],
    [100, 'item', '100 بند'],
    [1000, 'day', '1,000 يوم'],
    [1000, 'session', '1,000 جلسة'],
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
    [3, 'habit', '3 عادات'],
    [2, 'habit', 'عادتان'],
    [11, 'habit', '11 عادة'],
    [103, 'habit', '103 عادات'],
    [21, 'cycle', '21 دورة'],
    [2, 'cycle', 'دورتان'],
    [5, 'cycle', '5 دورات'],
    [3, 'priority', '3 أولويات'],
    [2, 'priority', 'أولويتان'],
    [11, 'priority', '11 أولوية'],
    [103, 'milestone', '103 محطات'],
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

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-11-00', '2027-02-29', 'not a date', ''])(
    'gives a dash for the impossible or malformed day %j',
    (text) => {
      expect(fmt.day(text)).toBe('—');
      expect(fmt.hijri(text)).toBe('—');
    },
  );

  it('accepts the last day of a leap February', () => {
    expect(fmt.day('2028-02-29')).toContain('29');
    expect(fmt.day('2028-02-29')).toContain('فبراير');
  });
});
