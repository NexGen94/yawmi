// @vitest-environment happy-dom
import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { PaceLine, paceNum } from '../src/charts/PaceLine';
import { Timeline } from '../src/charts/Timeline';
import type { PaceOut } from '../src/goals/types';
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
    // axe refuses aria-label on a role-less <line>: the name is the <title> of the mark's group
    expect(mark.querySelector('title')?.textContent).toContain('اليوم');
    expect(container.querySelector('line[aria-label], text[aria-label]')).toBeNull();
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
    expect(container.querySelector('.timeline-note')?.textContent).toBe('محطة واحدة بلا موعد لا تظهر على الخط.');
  });

  it('agrees the count of undated milestones with its noun', () => {
    const undated = (n: number) => Array.from({ length: n }, (_, i) => milestone(`u${i}`, 'م', { due_date: null }));
    const note = (n: number): string | null | undefined =>
      draw({ milestones: [...withEnds(), ...undated(n)] }).container.querySelector('.timeline-note')?.textContent;
    expect(note(2)).toBe('محطتان بلا موعد لا تظهر على الخط.');
    expect(note(3)).toBe('3 محطات بلا موعد لا تظهر على الخط.');
    expect(note(12)).toBe('12 محطة بلا موعد لا تظهر على الخط.');
  });

  it('keeps the outcome codes of the lanes in a layer that stays in sight while the chart scrolls', () => {
    const { container } = draw();
    const lanes = Array.from(container.querySelectorAll('.timeline-lanes [data-lane]')).map((l) => l.textContent);
    expect(lanes).toEqual(['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9', 'O10', 'O11', 'O12']);
    expect(container.querySelector('.timeline-lanes')?.getAttribute('aria-hidden')).toBe('true');
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

// The example of design 9.4: start 2026-11-01 at 0, due 2026-12-31 at 12, today 2026-11-16, value 2.
const PACE: PaceOut = {
  basis: 'kpi',
  kpi_code: 'books_done',
  unit: 'كتاب',
  start_day: '2026-11-01',
  start_value: 0,
  due_day: '2026-12-31',
  target_value: 12,
  today: '2026-11-16',
  current_value: 2,
  expected_today: 3,
  projected_end: 8,
  on_pace: false,
  days_left: 45,
  readings: [
    { day: '2026-11-03', value: 1 },
    { day: '2026-11-16', value: 2 },
  ],
};
const PACE_LABEL = 'وتيرة الهدف';

function drawPace(over: Partial<PaceOut> = {}) {
  const view = render(<PaceLine pace={{ ...PACE, ...over }} label={PACE_LABEL} />);
  const svg = view.container.querySelector('svg[role="img"]') as SVGSVGElement;
  return { ...view, svg };
}

describe('PaceLine', () => {
  it('says the value, the expected value today and the days left in its label (design 9.4)', () => {
    const { svg } = drawPace();
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain(PACE_LABEL);
    expect(label).toContain('القيمة 2');
    expect(label).toContain('المتوقع اليوم 3');
    expect(label).toContain('45 يوماً');
  });

  it('draws the expected line dashed and the actual line solid, each with a text label', () => {
    const { container } = drawPace();
    const expected = container.querySelector('.pace-expected') as Element;
    const actual = container.querySelector('.pace-actual') as Element;
    expect(expected).toBeTruthy();
    expect(actual).toBeTruthy();
    // a different stroke pattern: the lines never differ by colour alone
    expect(expected.getAttribute('stroke-dasharray') ?? '').not.toBe('');
    expect(actual.getAttribute('stroke-dasharray')).toBeNull();
    const words = Array.from(container.querySelectorAll('text')).map((t) => t.textContent);
    expect(words).toContain('المتوقع');
    expect(words).toContain('الفعلي');
  });

  it('draws the actual line from the readings, the first reading at the start side (the right)', () => {
    const { container } = drawPace();
    const points = (container.querySelector('.pace-actual') as Element)
      .getAttribute('points')!
      .trim()
      .split(/\s+/)
      .map((p) => p.split(',').map(Number) as [number, number]);
    expect(points).toHaveLength(2);
    expect(points[0]![0]).toBeGreaterThan(points[1]![0]);
    // the later reading is the higher value, so it sits higher (a smaller y)
    expect(points[1]![1]).toBeLessThan(points[0]![1]);
  });

  it('with no current value draws the expected line alone and says there is no reading yet', () => {
    const { container, svg } = drawPace({ current_value: null, projected_end: null, on_pace: null, readings: [] });
    expect(container.querySelector('.pace-expected')).toBeTruthy();
    expect(container.querySelector('.pace-actual')).toBeNull();
    expect(container.querySelector('.pace-dot')).toBeNull();
    expect(Array.from(container.querySelectorAll('text')).map((t) => t.textContent)).toContain('لا قراءة بعد');
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain('لا قراءة بعد');
    expect(label).toContain('المتوقع اليوم 3');
  });

  it('over milestones the expected value is marked as given: level at today, not a line to the target (Task 25, I-2)', () => {
    const { container } = drawPace({
      basis: 'milestones',
      kpi_code: null,
      unit: null,
      readings: [],
      current_value: 0,
      target_value: 9,
      expected_today: 0,
      projected_end: null,
      on_pace: true,
    });
    const expected = container.querySelector('.pace-expected') as Element;
    expect(expected).toBeTruthy();
    expect(expected.getAttribute('y1')).toBe(expected.getAttribute('y2'));
    const words = Array.from(container.querySelectorAll('text')).map((t) => t.textContent);
    expect(words).toContain('المتوقع');
  });

  it('draws a lone value (a pace over milestones has no readings) as a dot at today', () => {
    const { container } = drawPace({ basis: 'milestones', kpi_code: null, unit: null, readings: [] });
    expect(container.querySelector('.pace-actual')).toBeNull();
    expect(container.querySelector('.pace-dot')).toBeTruthy();
  });

  it('after the due day says how many days past it, not a negative count', () => {
    const { svg } = drawPace({ today: '2027-01-05', days_left: -5, expected_today: 12 });
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain('تجاوز الموعد بـ5 أيام');
    expect(label).not.toContain('-5');
  });

  it('with nothing to measure (a target of zero) draws no line and invents no pace', () => {
    const { container, svg } = drawPace({
      target_value: 0,
      expected_today: 0,
      current_value: null,
      projected_end: null,
      on_pace: null,
      readings: [],
    });
    expect(container.querySelector('.pace-expected')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBe(`${PACE_LABEL}: لا شيء يُقاس بعد`);
  });

  it('gives every <text> an explicit text-anchor and direction="rtl"', () => {
    const { container } = drawPace();
    for (const text of Array.from(container.querySelectorAll('text'))) {
      expect(text.getAttribute('text-anchor'), text.outerHTML).toMatch(/^(start|middle|end)$/);
      expect(text.getAttribute('direction'), text.outerHTML).toBe('rtl');
    }
  });

  it('keeps «الفعلي» above the dot when the value sits on the baseline, clear of the start date', () => {
    // the first weeks of every outcome: a value of 0 and an expected value a little above it
    const { container } = drawPace({ current_value: 0, expected_today: 0.014, on_pace: false, projected_end: 0, readings: [] });
    const dot = container.querySelector('.pace-dot') as Element;
    const word = container.querySelector('.pace-word-actual') as Element;
    expect(Number(word.getAttribute('y'))).toBeLessThan(Number(dot.getAttribute('cy')));
  });

  it('says «أقل من 1» for a pace value between 0 and 1, never «0» and never «0.01» (Task 24)', () => {
    const { svg } = drawPace({ current_value: 0, expected_today: 0.014, on_pace: false, projected_end: null, readings: [] });
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain('المتوقع اليوم أقل من 1');
    expect(label).not.toMatch(/المتوقع اليوم 0(،|$)/);
    expect(label).not.toContain('0.01');
  });

  it('says «أقل من 1» for a value smaller than that too', () => {
    const { svg } = drawPace({ current_value: 0, expected_today: 0.001, on_pace: false, projected_end: null, readings: [] });
    expect(svg.getAttribute('aria-label')).toContain('المتوقع اليوم أقل من 1');
  });

  it('never shows an expected end above the target: «2 من 2», not «134.8 من 2»', () => {
    const { svg } = drawPace({ target_value: 2, projected_end: 134.8 });
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain('المتوقع عند الموعد 2 من 2');
    expect(label).not.toContain('134');
  });

  it('rounds: one decimal under 10, a whole number from 10', () => {
    expect(paceNum(0)).toBe('0');
    expect(paceNum(3.04)).toBe('3');
    expect(paceNum(3.46)).toBe('3.5');
    expect(paceNum(12.4)).toBe('12');
    expect(paceNum(134.8)).toBe('135');
  });

  it('keeps one decimal for values of 1 and over, and writes a whole number without decimals', () => {
    const { svg } = drawPace({ current_value: 2, expected_today: 3.04, projected_end: 8 });
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain('القيمة 2،');
    expect(label).toContain('المتوقع اليوم 3،');
  });
});

describe('Timeline: the plan year (Task 24)', () => {
  it('draws only the plan year that holds today, with the cycles and milestones of it', () => {
    const full = draw();
    const year = draw({ range: 'year' });
    const marks = (c: Element): number => c.querySelectorAll('[data-milestone]').length;
    expect(marks(year.container)).toBeLessThan(marks(full.container));
    expect(year.container.querySelectorAll('rect.timeline-cycle').length).toBeLessThan(21);
    // the first year: no Gregorian year label but 2027, which the plan year ends on
    expect(Array.from(year.container.querySelectorAll('text.timeline-year')).map((t) => t.textContent)).toEqual(['2027']);
    // the milestones that are drawn have room: none is within 2 px of its neighbour in the same lane at this scale
    expect(year.container.querySelector('.timeline-today')).not.toBeNull();
  });

  it('a cycle is a tick and a number, not a box', () => {
    const { container } = draw();
    expect(container.querySelectorAll('line.timeline-cycle-tick')).toHaveLength(21);
  });

  it('the today line is drawn before (under) the marks of the milestones', () => {
    const { container } = draw();
    const all = Array.from(container.querySelectorAll('svg > *'));
    const today = all.findIndex((e) => e.classList.contains('timeline-today'));
    const firstMark = all.findIndex((e) => e.hasAttribute('data-milestone'));
    expect(today).toBeGreaterThan(-1);
    expect(today).toBeLessThan(firstMark);
  });
});
