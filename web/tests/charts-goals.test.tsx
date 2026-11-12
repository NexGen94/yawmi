// @vitest-environment happy-dom
import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { Timeline } from '../src/charts/Timeline';
import { cycles, milestone, milestones, TODAY } from './helpers/goals-fixtures';

const LABEL = 'الخط الزمني للخطة';
const ARABIC = /[؀-ۿ]/;

/** Milestones of the story, plus one on the first day of the plan and one on its last. */
const withEnds = () => [
  ...milestones(),
  milestone('m-first', 'أول يوم', { outcome_code: 'O3', due_date: '2026-10-31', done: true }),
  milestone('m-last', 'آخر يوم', { outcome_code: 'O3', due_date: '2031-12-31' }),
];

function draw(over: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const view = render(<Timeline cycles={cycles()} milestones={withEnds()} today={TODAY} label={LABEL} {...over} />);
  const svg = view.container.querySelector('svg[role="img"]') as SVGSVGElement;
  return { ...view, svg };
}

const xOfPoint = (container: Element, id: string): number =>
  Number((container.querySelector(`[data-milestone="${id}"]`) as Element).getAttribute('data-x'));

describe('Timeline', () => {
  it('is one svg with role="img" and an Arabic label that says what it holds', () => {
    const { svg } = draw();
    expect(svg).toBeTruthy();
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain(LABEL);
    expect(label).toContain('21 دورة');
    expect(label).toContain('4 من 124');
  });

  it('puts 2026-10-31 at the far start (the right edge) and 2031-12-31 at the far end (the left)', () => {
    const { container } = draw();
    const first = xOfPoint(container, 'm-first');
    const last = xOfPoint(container, 'm-last');
    const others = Array.from(container.querySelectorAll('[data-milestone]'))
      .filter((el) => !['m-first', 'm-last'].includes(el.getAttribute('data-milestone') ?? ''))
      .map((el) => Number(el.getAttribute('data-x')));
    expect(others.length).toBeGreaterThan(100);
    expect(first).toBeGreaterThan(Math.max(...others));
    expect(last).toBeLessThan(Math.min(...others));
    expect(first).toBeGreaterThan(last);
  });

  it('draws one bar per cycle, the first at the start and the last nearest the end', () => {
    const { container } = draw();
    const bars = Array.from(container.querySelectorAll('rect.timeline-cycle'));
    expect(bars).toHaveLength(21);
    const left = (el: Element): number => Number(el.getAttribute('x'));
    const byNo = (n: number): Element => container.querySelector(`rect.timeline-cycle[data-cycle="${n}"]`) as Element;
    expect(left(byNo(1))).toBeGreaterThan(left(byNo(2)));
    expect(left(byNo(2))).toBeGreaterThan(left(byNo(21)));
  });

  it('marks the current cycle apart from the others by more than colour', () => {
    const { container } = draw();
    const now = container.querySelectorAll('rect.timeline-cycle-now');
    expect(now).toHaveLength(1);
    expect(now[0]?.getAttribute('data-cycle')).toBe('1');
  });

  it('marks today with a line whose label says «اليوم», between the start and the end', () => {
    const { container } = draw();
    const mark = container.querySelector('.timeline-today') as Element;
    expect(mark.getAttribute('aria-label')).toContain('اليوم');
    const x = Number(mark.getAttribute('data-x'));
    expect(x).toBeLessThan(xOfPoint(container, 'm-first'));
    expect(x).toBeGreaterThan(xOfPoint(container, 'm-last'));
  });

  it('labels the years in both calendars: Gregorian 2027 to 2031 and Hijri 1449 to 1453', () => {
    const { container } = draw();
    const years = Array.from(container.querySelectorAll('text.timeline-year')).map((t) => t.textContent);
    expect(years).toEqual(['2027', '2028', '2029', '2030', '2031']);
    const hijri = Array.from(container.querySelectorAll('text.timeline-hijri')).map((t) => t.textContent);
    expect(hijri).toEqual(['1449 هـ', '1450 هـ', '1451 هـ', '1452 هـ', '1453 هـ']);
  });

  it('writes the year labels from the start towards the end, Gregorian 2027 to the right of 2031', () => {
    const { container } = draw();
    const x = (el: Element): number => Number(el.getAttribute('x'));
    const years = Array.from(container.querySelectorAll('text.timeline-year'));
    expect(x(years[0] as Element)).toBeGreaterThan(x(years[4] as Element));
  });

  it('gives every <text> an explicit text-anchor and direction="rtl"', () => {
    const { container } = draw();
    const texts = Array.from(container.querySelectorAll('text'));
    expect(texts.length).toBeGreaterThan(10);
    for (const text of texts) {
      expect(text.getAttribute('text-anchor'), text.outerHTML).toMatch(/^(start|middle|end)$/);
      expect(text.getAttribute('direction'), text.outerHTML).toBe('rtl');
    }
    expect(texts.some((t) => ARABIC.test(t.textContent ?? ''))).toBe(true);
  });

  it('tells done, open and late milestones apart by shape, not by colour alone', () => {
    const { container } = draw();
    const shape = (id: string): string | null =>
      (container.querySelector(`[data-milestone="${id}"]`) as Element).getAttribute('data-state');
    expect(shape('m-first')).toBe('done');
    expect(shape('m-blood')).toBe('open');
    expect(shape('m-late')).toBe('late');
    const tag = (id: string): string => (container.querySelector(`[data-milestone="${id}"] > :not(title)`) as Element).tagName;
    expect(new Set([tag('m-first'), tag('m-blood'), tag('m-late')]).size).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll('.timeline-key li')).toHaveLength(3);
  });

  it('each point has a title with the milestone and its date', () => {
    const { container } = draw();
    const title = container.querySelector('[data-milestone="m-blood"] title')?.textContent ?? '';
    expect(title).toContain('فحص الدم السنوي');
    expect(title).toContain('12 نوفمبر 2026');
  });

  it('says how many milestones have no date, and does not draw them', () => {
    const { container } = draw({ milestones: [...withEnds(), milestone('m-undated', 'بلا موعد', { due_date: null })] });
    expect(container.querySelector('[data-milestone="m-undated"]')).toBeNull();
    expect(container.querySelector('.timeline-note')?.textContent).toContain('محطة بلا موعد');
  });

  it('holds a date outside the plan at the nearest end', () => {
    const { container } = draw({ milestones: [milestone('early', 'سابق', { due_date: '2026-10-01' }), milestone('late', 'لاحق', { due_date: '2032-06-01' })] });
    expect(xOfPoint(container, 'early')).toBeGreaterThan(xOfPoint(container, 'late'));
  });

  it('with nothing to draw it says there is no data yet', () => {
    const { svg } = draw({ cycles: [], milestones: [] });
    expect(svg.getAttribute('aria-label')).toBe(`${LABEL}: لا بيانات بعد`);
  });
});
