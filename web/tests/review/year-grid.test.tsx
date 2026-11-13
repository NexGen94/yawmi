// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { YearGrid } from '../../src/charts/YearGrid';

const cell = (container: Element, day: string): SVGRectElement => {
  const found = container.querySelector<SVGRectElement>(`[data-day="${day}"]`);
  if (found === null) throw new Error(`no cell for ${day}`);
  return found;
};

describe('YearGrid', () => {
  it('has a cell for every day of the year: 365, and 366 in a leap year', () => {
    const a = render(<YearGrid year={2026} days={[]} label="المزاج في 2026: لا بيانات بعد" />);
    expect(a.container.querySelectorAll('.year-svg [data-day]')).toHaveLength(365);
    a.unmount();
    const b = render(<YearGrid year={2028} days={[]} label="س" />);
    expect(b.container.querySelectorAll('.year-svg [data-day]')).toHaveLength(366);
  });

  it('is an image named by its label', () => {
    render(<YearGrid year={2026} days={[{ day: '2026-11-01', score: 4 }]} label="المزاج في 2026: يوم مسجّل" />);
    expect(screen.getByRole('img', { name: 'المزاج في 2026: يوم مسجّل' })).toBeTruthy();
  });

  it('lays the weeks out from the right edge, Sunday on top (Thursday 1 January 2026 is the fifth row)', () => {
    const { container } = render(<YearGrid year={2026} days={[]} label="س" />);
    const x = (day: string): number => Number(cell(container, day).getAttribute('x'));
    const y = (day: string): number => Number(cell(container, day).getAttribute('y'));
    // the first week is at the right, so a later week has a smaller x
    expect(x('2026-01-01')).toBeGreaterThan(x('2026-01-04'));
    expect(x('2026-01-04')).toBeGreaterThan(x('2026-01-11'));
    // the days of one week share a column; Sunday 4 January is the top of the next one
    expect(x('2026-01-04')).toBe(x('2026-01-10'));
    expect(y('2026-01-04')).toBe(0);
    expect(y('2026-01-01')).toBe(4 * 15);
    expect(y('2026-01-10')).toBe(6 * 15);
    // the cells fit the box they are drawn in
    const box = container.querySelector('svg')?.getAttribute('viewBox')?.split(' ').map(Number) ?? [];
    expect(Math.min(...[...container.querySelectorAll('.year-svg [data-day]')].map((c) => Number(c.getAttribute('x'))))).toBeGreaterThanOrEqual(0);
    expect(box[2]).toBe(53 * 15 - 3);
    expect(box[3]).toBe(7 * 15 - 3);
  });

  it('shades only the days with a mood, by grade, and gives each its word in a title', () => {
    const { container } = render(
      <YearGrid
        year={2026}
        days={[
          { day: '2026-11-01', score: 1 },
          { day: '2026-11-02', score: 5 },
        ]}
        label="س"
      />,
    );
    expect(container.querySelectorAll('[data-score]')).toHaveLength(2);
    expect(cell(container, '2026-11-01').getAttribute('fill-opacity')).toBe('0.2');
    expect(cell(container, '2026-11-02').getAttribute('fill-opacity')).toBe('1');
    expect(cell(container, '2026-11-03').getAttribute('data-score')).toBeNull();
    expect(cell(container, '2026-11-02').textContent).toContain('2 نوفمبر: 5');
  });

  it('a score outside 1 to 5 is drawn at the nearest grade', () => {
    const { container } = render(<YearGrid year={2026} days={[{ day: '2026-02-01', score: 9 }, { day: '2026-02-02', score: 0 }]} label="س" />);
    expect(cell(container, '2026-02-01').getAttribute('fill-opacity')).toBe('1');
    expect(cell(container, '2026-02-02').getAttribute('fill-opacity')).toBe('0.2');
  });

  it('the key names the five grades and the empty cell', () => {
    render(<YearGrid year={2026} days={[]} label="س" />);
    const key = screen.getByRole('list', { name: 'مفتاح درجات المزاج' });
    expect(within(key).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('الخانة الفارغة يوم بلا تسجيل للمزاج')).toBeTruthy();
  });
});
