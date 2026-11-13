// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HourBars } from '../src/charts/HourBars';
import { Plant } from '../src/charts/Plant';
import { setDigits } from '../src/lib/format';

afterEach(() => {
  setDigits('latn');
  vi.unstubAllGlobals();
});

function reduceMotion(on: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({
      matches: on && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  );
}

describe('Plant', () => {
  it('names the stage in its label', () => {
    render(<Plant stage={2} />);
    expect(screen.getByRole('img', { name: 'نبتة التركيز: المرحلة 2 من 4' })).toBeTruthy();
  });

  it('draws more of the plant as the stage grows', () => {
    const on = (stage: 0 | 1 | 2 | 3 | 4): number => {
      const { container, unmount } = render(<Plant stage={stage} />);
      const count = container.querySelectorAll('[data-on="true"]').length;
      unmount();
      return count;
    };
    const counts = [0, 1, 2, 3, 4].map((s) => on(s as 0 | 1 | 2 | 3 | 4));
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBe(5);
  });

  it('prefers-reduced-motion stops the growth animation', () => {
    reduceMotion(true);
    const { container } = render(<Plant stage={3} />);
    expect(container.querySelector('svg')?.classList.contains('plant-still')).toBe(true);
  });

  it('without the preference the plant grows with a transition', () => {
    reduceMotion(false);
    const { container } = render(<Plant stage={3} />);
    expect(container.querySelector('svg')?.classList.contains('plant-still')).toBe(false);
  });

  it('the stylesheet removes the transition under prefers-reduced-motion', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/charts/focus-charts.css'), 'utf8');
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(block?.[1]).toMatch(/\.plant-part[\s\S]*transition:\s*none/);
    expect(css).toMatch(/\.plant-still\s+\.plant-part[\s\S]*transition:\s*none/);
  });
});

describe('HourBars', () => {
  const bins = Array.from({ length: 24 }, () => 0);

  it('says which hour holds the most focus', () => {
    const data = [...bins];
    data[9] = 20;
    data[10] = 30;
    render(<HourBars bins={data} />);
    const chart = screen.getByRole('img');
    expect(chart.getAttribute('aria-label')).toBe('توزيع ساعات التركيز: أكثر ساعة تركيزاً 10:00 بـ30 دقيقة');
  });

  it('draws 24 bars with a tooltip each', () => {
    const data = [...bins];
    data[10] = 30;
    const { container } = render(<HourBars bins={data} />);
    expect(container.querySelectorAll('.hour-bar')).toHaveLength(24);
    expect(container.querySelector('.hour-bar-top title')?.textContent).toBe('10:00 · 30 دقيقة');
  });

  it('with no sessions says there is no data yet', () => {
    render(<HourBars bins={bins} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('توزيع ساعات التركيز: لا بيانات بعد');
  });

  it('writes the hours in the digits of the setting', () => {
    setDigits('arab');
    const data = [...bins];
    data[10] = 30;
    render(<HourBars bins={data} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('١٠:٠٠');
  });
});
