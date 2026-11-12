// @vitest-environment happy-dom
import { render } from '@testing-library/preact';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Heatmap } from '../src/charts/Heatmap';
import { ProgressBar } from '../src/charts/ProgressBar';
import { Ring } from '../src/charts/Ring';
import { flip, x } from '../src/charts/rtl';
import { Sparkline } from '../src/charts/Sparkline';
import { WeekBars } from '../src/charts/WeekBars';
import { setDigits } from '../src/lib/format';

const ARABIC = /[؀-ۿ]/;

/** Every <text> in the container states its anchor (SVG anchors are physical, not logical), and
 *  every Arabic <text> also states direction="rtl". */
function expectAnchoredText(container: Element): void {
  for (const text of container.querySelectorAll('text')) {
    expect(text.getAttribute('text-anchor'), text.outerHTML).toMatch(/^(start|middle|end)$/);
    if (ARABIC.test(text.textContent ?? '')) expect(text.getAttribute('direction'), text.outerHTML).toBe('rtl');
  }
}

function chart(container: Element): SVGSVGElement {
  const svg = container.querySelector('svg[role="img"]');
  expect(svg, 'a chart is one svg with role="img"').toBeTruthy();
  return svg as SVGSVGElement;
}

const dashOf = (el: Element | null | undefined): number[] =>
  (el?.getAttribute('stroke-dasharray') ?? '').split(/[\s,]+/).map(Number);

describe('rtl.ts', () => {
  it('x() puts index 0 at the inline start, which is the right edge in RTL', () => {
    expect(x(0, 8, 320)).toBeGreaterThan(x(7, 8, 320));
  });

  it('x() returns the centre of each slot, mirrored', () => {
    expect(x(0, 8, 320)).toBe(300);
    expect(x(7, 8, 320)).toBe(20);
    expect(x(0, 1, 100)).toBe(50);
  });

  it('flip() mirrors a horizontal position inside a width', () => {
    expect(flip(0, 320)).toBe(320);
    expect(flip(320, 320)).toBe(0);
    expect(flip(80, 320)).toBe(240);
  });
});

describe('Ring', () => {
  it('draws half the circumference for 0.5, with one Arabic label that carries the number', () => {
    const { container } = render(<Ring value={0.5} label="إنجاز اليوم" />);
    const svg = chart(container);
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain('إنجاز اليوم');
    expect(label).toContain('50');

    const arc = svg.querySelector('.ring-arc');
    expect(arc).toBeTruthy();
    const circumference = 2 * Math.PI * Number(arc?.getAttribute('r'));
    const [dash, gap] = dashOf(arc);
    expect(dash).toBeCloseTo(circumference / 2, 3);
    expect(gap).toBeGreaterThanOrEqual(circumference / 2);
  });

  it('clamps out-of-range values and shows a dash for a missing one', () => {
    const over = render(<Ring value={1.7} label="أ" />);
    const arc = over.container.querySelector('.ring-arc');
    expect(dashOf(arc)[0]).toBeCloseTo(2 * Math.PI * Number(arc?.getAttribute('r')), 3);
    expect(chart(over.container).getAttribute('aria-label')).toContain('100');
    over.unmount();

    const { container } = render(<Ring value={Number.NaN} label="ب" />);
    expect(chart(container).getAttribute('aria-label')).toBe('ب: —');
    expect(dashOf(container.querySelector('.ring-arc'))[0]).toBe(0);
    expect(container.textContent).not.toContain('NaN');
  });

  it('honours size, keeps small rings readable, and does not round 0.999 to 100%', () => {
    const { container } = render(<Ring value={0.25} label="ج" size={160} />);
    const svg = chart(container);
    expect(svg.getAttribute('width')).toBe('160');
    expect(svg.getAttribute('height')).toBe('160');
    expectAnchoredText(container);

    const mid = render(<Ring value={0.5} label="وسط" size={48} />);
    expect(Number(mid.container.querySelector('.ring-value')?.getAttribute('font-size'))).toBeGreaterThanOrEqual(12);
    mid.unmount();

    const tiny = render(<Ring value={0.5} label="صغير" size={24} />);
    expect(tiny.container.querySelector('.ring-value')).toBeNull();
    expect(chart(tiny.container).getAttribute('aria-label')).toContain('50%');
    tiny.unmount();

    const almost = render(<Ring value={0.999} label="قرب التمام" />);
    expect(almost.container.querySelector('.ring-value')?.textContent).toBe('99%');
    expect(chart(almost.container).getAttribute('aria-label')).toBe('قرب التمام: 99%');
    almost.unmount();
  });

  it('fills from the top towards the inline end (counter-clockwise in RTL), mirrored through rtl.ts', () => {
    const { container } = render(<Ring value={0.5} label="د" />);
    expect(container.querySelector('.ring-arc')?.getAttribute('transform')).toContain('scale(-1');
  });

  it('sets explicit text-anchor and direction="rtl" on <text> even with Arabic-Indic digits', () => {
    setDigits('arab');
    try {
      const { container } = render(
        <>
          <Ring value={0.5} label="إنجاز اليوم" />
          <WeekBars values={[2, 5, 8]} label="آخر الفترات" />
        </>,
      );
      expectAnchoredText(container);
    } finally {
      setDigits('latn');
    }
  });

  it('every chart .tsx mirrors horizontally through x() from rtl.ts only', () => {
    const chartsDir = resolve(import.meta.dirname, '..', 'src', 'charts');
    const chartFiles = readdirSync(chartsDir).filter((f) => f.endsWith('.tsx'));
    expect(chartFiles.length).toBeGreaterThanOrEqual(5);
    for (const file of chartFiles) {
      const source = readFileSync(join(chartsDir, file), 'utf8');
      expect(source, file).toMatch(/import\s*\{\s*x\s*\}\s*from\s*['"]\.\/rtl['"]/);
      expect(source, file).not.toMatch(/\bflip\b/);
    }
  });
});

describe('ProgressBar', () => {
  it('fills from the inline start (the right in RTL) and labels the value in Arabic', () => {
    const { container } = render(<ProgressBar value={0.25} label="تقدّم الفترة" />);
    const svg = chart(container);
    expect(svg.getAttribute('aria-label')).toBe('تقدّم الفترة: 25%');
    const fill = svg.querySelector('.bar-fill');
    expect(fill?.getAttribute('x')).toBe('75%');
    expect(fill?.getAttribute('width')).toBe('25%');
  });

  it('never draws past the track', () => {
    const { container } = render(<ProgressBar value={3} label="أ" />);
    const fill = container.querySelector('.bar-fill');
    expect(fill?.getAttribute('x')).toBe('0%');
    expect(fill?.getAttribute('width')).toBe('100%');
  });

  it('shows a dash for a missing value', () => {
    const { container } = render(<ProgressBar value={Number.NaN} label="أ" />);
    expect(chart(container).getAttribute('aria-label')).toBe('أ: —');
  });
});

describe('WeekBars', () => {
  it('draws one bar per value, oldest at the inline start, and names the latest value', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 3];
    const { container } = render(<WeekBars values={values} label="آخر الفترات" />);
    const svg = chart(container);
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain('آخر الفترات');
    expect(label).toContain('3');
    expect(label).toContain('7');

    const bars = [...svg.querySelectorAll('.bars-bar')];
    expect(bars).toHaveLength(8);
    const centre = (bar: Element | undefined): number =>
      Number(bar?.getAttribute('x')) + Number(bar?.getAttribute('width')) / 2;
    expect(centre(bars[0])).toBeGreaterThan(centre(bars[7]));
    expect(Number(bars[6]?.getAttribute('height'))).toBeGreaterThan(Number(bars[0]?.getAttribute('height')));
    expectAnchoredText(container);
  });

  it('says there is no data when there are no values', () => {
    const { container } = render(<WeekBars values={[]} label="أ" />);
    expect(chart(container).getAttribute('aria-label')).toBe('أ: لا بيانات بعد');
  });

  it('does not turn NaN or negative values into 0 in its label, says «لا بيانات» for missing slots, and clamps negatives explicitly', () => {
    const { container } = render(<WeekBars values={[Number.NaN, -3, 5]} label="آخر الفترات" />);
    const svg = chart(container);
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).not.toContain('الأدنى 0');
    expect(label).toContain('لا بيانات');
    expect(label).toContain('مقصوص');
    const bars = [...svg.querySelectorAll('.bars-bar')];
    expect(bars).toHaveLength(2);
    expect(Number(bars[0]?.getAttribute('height'))).toBe(2);

    const trailingMissing = render(<WeekBars values={[2, 5, Number.NaN]} label="فترة" />);
    expect(chart(trailingMissing.container).getAttribute('aria-label')).toContain('الأحدث لا بيانات');
    expect(trailingMissing.container.textContent).not.toContain('NaN');
    trailingMissing.unmount();
  });

  it('keeps the latest number inside the chart bounds even with 60 bars and a 4-digit value', () => {
    const values = [...Array.from({ length: 59 }, (_, i) => (i % 10) + 1), 1059];
    const { container } = render(<WeekBars values={values} label="ستون" />);
    const text = container.querySelector('.bars-value');
    expect(text?.textContent).toBe('1,059');
    expect(Number(text?.getAttribute('x'))).toBeGreaterThanOrEqual(20);
  });
});

describe('Sparkline', () => {
  it('draws a line from the inline start and names the first and last values', () => {
    const { container } = render(<Sparkline values={[2, 4, 3, 9]} label="المؤشر" />);
    const svg = chart(container);
    const label = svg.getAttribute('aria-label') ?? '';
    expect(label).toContain('المؤشر');
    expect(label).toContain('2');
    expect(label).toContain('9');
    const points = (svg.querySelector('.spark-line')?.getAttribute('points') ?? '').trim().split(/\s+/);
    expect(points).toHaveLength(4);
    const xAt = (i: number): number => Number(points[i]?.split(',')[0]);
    expect(xAt(0)).toBeGreaterThan(xAt(3));
    expectAnchoredText(container);
  });

  it('keeps finite points at their true slot positions when a middle value is NaN', () => {
    const { container } = render(<Sparkline values={[2, Number.NaN, 4, 9]} label="المؤشر" />);
    const svg = chart(container);
    const points = (svg.querySelector('.spark-line')?.getAttribute('points') ?? '').trim().split(/\s+/);
    expect(points).toHaveLength(3);
    const xAt = (i: number): number => Number(points[i]?.split(',')[0]);
    expect(xAt(0)).toBe(x(0, 4, 160));
    expect(xAt(1)).toBe(x(2, 4, 160));
    expect(xAt(2)).toBe(x(3, 4, 160));
  });

  it('says there is no data when there are no values', () => {
    const { container } = render(<Sparkline values={[]} label="أ" />);
    expect(chart(container).getAttribute('aria-label')).toBe('أ: لا بيانات بعد');
  });
});

describe('Heatmap', () => {
  const states = ['done', 'missed', 'skipped', 'off'] as const;
  type State = (typeof states)[number];
  const days = Array.from({ length: 14 }, (_, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, '0')}`,
    state: states[i % 4] as State,
  }));

  /** The shape of a cell with every colour taken away: element names, plus the fill only when it
   *  names a pattern. Classes, which carry the colour, are ignored. */
  function signature(cell: Element): string {
    return [...cell.children]
      .filter((el) => el.tagName.toLowerCase() !== 'title')
      .map((el) => el.tagName.toLowerCase() + ((el.getAttribute('fill') ?? '').startsWith('url(') ? '[pattern]' : ''))
      .join('+');
  }

  it('draws each state with its own shape or pattern, not a colour alone', () => {
    const { container } = render(<Heatmap days={days} label="أيام الدورة" />);
    const byState = new Map<string, Set<string>>();
    for (const cell of chart(container).querySelectorAll('[data-state]')) {
      const state = cell.getAttribute('data-state') ?? '';
      const seen = byState.get(state) ?? new Set<string>();
      seen.add(signature(cell));
      byState.set(state, seen);
    }
    expect([...byState.keys()].sort()).toEqual([...states].sort());
    const sigs = states.map((s) => [...(byState.get(s) ?? [])]);
    for (const sig of sigs) expect(sig).toHaveLength(1);
    expect(new Set(sigs.map((s) => s[0])).size).toBe(4);
  });

  it('has a text key for the four states that draws the same symbols', () => {
    const { container } = render(<Heatmap days={days} label="أيام الدورة" />);
    const key = container.querySelector('.heat-key');
    expect(key).toBeTruthy();
    for (const word of ['منجز', 'لم يُنجز', 'متخطّى', 'غير مجدول']) expect(key?.textContent).toContain(word);
    expect(key?.querySelectorAll('[data-state]')).toHaveLength(4);
  });

  it('counts the states in one Arabic sentence', () => {
    const { container } = render(<Heatmap days={days} label="أيام الدورة" />);
    const label = chart(container).getAttribute('aria-label') ?? '';
    // 14 days cycling the four states: done 4, missed 4, skipped 3, off 3.
    expect(label).toBe('أيام الدورة، 14 يوماً: منجز 4، ولم يُنجز 4، ومتخطّى 3، وغير مجدول 3');
  });

  it('lays the days out as a calendar, the first day at the inline start (the right in RTL)', () => {
    const { container } = render(<Heatmap days={days} label="أ" />);
    const cells = [...chart(container).querySelectorAll('[data-state]')];
    const xOf = (cell: Element | undefined): number => Number(cell?.getAttribute('data-x'));
    const yOf = (cell: Element | undefined): number => Number(cell?.getAttribute('data-y'));
    expect(xOf(cells[0])).toBeGreaterThan(xOf(cells[6]));
    expect(xOf(cells[0])).toBe(xOf(cells[7]));
    expect(yOf(cells[7])).toBeGreaterThan(yOf(cells[0]));
  });

  it('says «لا بيانات بعد» when there are no days', () => {
    const { container } = render(<Heatmap days={[]} label="أيام الدورة" />);
    expect(chart(container).getAttribute('aria-label')).toBe('أيام الدورة: لا بيانات بعد');
  });
});
