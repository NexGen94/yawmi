import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { fmt } from '../lib/format';
import { x } from './rtl';
import { emptyLabel } from './scale';

export interface WeekBarsProps {
  /** One value per period, oldest first. The oldest sits at the inline start (the right). */
  values: number[];
  /** What the bars count, in Arabic. */
  label: string;
}

const W = 320;
const H = 120;
const TOP = 22; // room for the number over the latest bar
const BASE = H - 2; // the baseline, with room for its hairline

/** Bars for the last periods. Only the latest bar carries its number; each bar has a tooltip
 *  (title) with its own value. */
export function WeekBars({ values, label }: WeekBarsProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(W);

  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const update = () => {
      const cw = Math.round(el.getBoundingClientRect().width || el.clientWidth);
      if (cw > 0) setW(cw);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = values.length;
  const finite = values.filter((v) => Number.isFinite(v));
  if (n === 0 || finite.length === 0) {
    return (
      <svg
        ref={svgRef}
        class="chart bars"
        role="img"
        aria-label={emptyLabel(label)}
        viewBox={`0 0 ${w} ${H}`}
        focusable="false"
      >
        <line class="bars-base" x1="0" y1={BASE} x2={w} y2={BASE} />
      </svg>
    );
  }

  const max = Math.max(...finite);
  const min = Math.min(...finite);
  const maxBar = Math.max(0, max);
  const rawLast = values[n - 1];
  const lastFinite = rawLast !== undefined && Number.isFinite(rawLast) ? rawLast : undefined;
  const missingCount = n - finite.length;
  const hasNegative = finite.some((v) => v < 0);
  const bar = Math.min(24, (w / n) * 0.6);
  // A zero (or clamped negative) draws a 2px stub on the baseline, so its slot is visible.
  const heightOf = (v: number): number => {
    const clamped = Math.max(0, v);
    return maxBar > 0 ? Math.max(2, (clamped / maxBar) * (BASE - TOP)) : 2;
  };

  const lastDesc = lastFinite === undefined ? 'لا بيانات' : fmt.num(lastFinite);
  const notes: string[] = [];
  if (missingCount > 0 && lastFinite !== undefined) notes.push('بعض الفترات بلا بيانات');
  if (hasNegative) notes.push('القيم السالبة مقصوصة عند 0');
  const suffix = notes.length > 0 ? ` (${notes.join('، ')})` : '';
  const sentence = `${label}: الأحدث ${lastDesc}، والأعلى ${fmt.num(max)}، والأدنى ${fmt.num(min)}${suffix}`;

  const lastSlotX = x(n - 1, n, w);
  const lastText = lastFinite === undefined ? undefined : fmt.num(lastFinite);
  const halfLabel = lastText ? Math.min(w / 2, Math.max(12, lastText.length * 4.5)) : 0;
  const textX = Math.max(halfLabel, Math.min(w - halfLabel, lastSlotX));

  return (
    <svg
      ref={svgRef}
      class="chart bars"
      role="img"
      aria-label={sentence}
      viewBox={`0 0 ${w} ${H}`}
      focusable="false"
    >
      <line class="bars-base" x1="0" y1={BASE} x2={w} y2={BASE} />
      {values.map((v, i) => {
        if (!Number.isFinite(v)) return null;
        const h = heightOf(v);
        const slotX = x(i, n, w);
        return (
          <rect
            key={slotX}
            class={i === n - 1 ? 'bars-bar bars-latest' : 'bars-bar'}
            x={slotX - bar / 2}
            y={BASE - h}
            width={bar}
            height={h}
            rx={Math.min(4, bar / 2)}
          >
            <title>{v < 0 ? `${fmt.num(v)} (مقصوص عند 0)` : fmt.num(v)}</title>
          </rect>
        );
      })}
      {lastFinite !== undefined && lastText !== undefined && (
        <text
          class="bars-value"
          x={textX}
          y={BASE - heightOf(lastFinite) - 6}
          direction="rtl"
          text-anchor="middle"
        >
          {lastText}
        </text>
      )}
    </svg>
  );
}
