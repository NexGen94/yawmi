import { useId } from 'preact/hooks';

import { fmt } from '../lib/format';
import { x } from './rtl';

export type DayState = 'done' | 'missed' | 'skipped' | 'off';

export interface HeatmapProps {
  /** The days in order (ISO day and state), laid out as a calendar: rows of 7 from the right. */
  days: { day: string; state: DayState }[];
  /** What the grid shows, in Arabic. */
  label: string;
}

/** Each state has its own word and its own shape, so nothing is told by colour alone. */
const WORDS: Record<DayState, string> = {
  done: 'منجز',
  missed: 'لم يُنجز',
  skipped: 'متخطّى',
  off: 'غير مجدول',
};
const ORDER: DayState[] = ['done', 'missed', 'skipped', 'off'];

const CELL = 24;
const GAP = 4;
const COLS = 7;

/** One day's symbol centred on (cx, cy): a filled square (done), an outlined square with a cross
 *  (missed), a hatched square (skipped), a small dot (off). */
function DaySymbol(props: { state: DayState; cx: number; cy: number; size: number; hatch: string }) {
  const { state, cx, cy, size, hatch } = props;
  const top = cy - size / 2;
  const start = cx - size / 2;
  switch (state) {
    case 'done':
      return <rect class="heat-done" x={start} y={top} width={size} height={size} rx="4" />;
    case 'missed': {
      const i = size * 0.32;
      const end = start + size;
      const bottom = top + size;
      return (
        <>
          <rect class="heat-missed" fill="none" x={start + 1} y={top + 1} width={size - 2} height={size - 2} rx="4" />
          <path
            class="heat-cross"
            fill="none"
            d={`M${start + i} ${top + i}L${end - i} ${bottom - i}M${end - i} ${top + i}L${start + i} ${bottom - i}`}
          />
        </>
      );
    }
    case 'skipped':
      return <rect class="heat-skipped" fill={`url(#${hatch})`} x={start} y={top} width={size} height={size} rx="4" />;
    case 'off':
      return <circle class="heat-off" cx={cx} cy={cy} r={size * 0.14} />;
  }
}

/** The days of a cycle as a calendar grid, with a text key under it. */
export function Heatmap({ days, label }: HeatmapProps) {
  const hatch = `hatch-${useId().replace(/[^\w-]/g, '')}`;
  const n = days.length;
  const rows = Math.max(1, Math.ceil(n / COLS));
  const slot = CELL + GAP;
  const width = COLS * slot - GAP;
  const height = rows * slot - GAP;
  const counts: Record<DayState, number> = { done: 0, missed: 0, skipped: 0, off: 0 };
  for (const d of days) counts[d.state] += 1;
  const sentence =
    `${label}، ${fmt.count(n, 'day')}: ` +
    ORDER.map((s, i) => `${i === 0 ? '' : 'و'}${WORDS[s]} ${fmt.num(counts[s])}`).join('، ');

  return (
    <div class="heatmap">
      <svg
        class="chart heat"
        role="img"
        aria-label={sentence}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        focusable="false"
      >
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect class="heat-hatch-bg" width="6" height="6" />
            <line class="heat-hatch" x1="1.5" y1="0" x2="1.5" y2="6" />
          </pattern>
        </defs>
        {days.map((d, i) => {
          // COLS slots of CELL + GAP; the last slot's trailing gap falls outside the view box.
          const cx = x(i % COLS, COLS, width + GAP) - GAP / 2;
          const cy = Math.floor(i / COLS) * slot + CELL / 2;
          return (
            <g key={d.day} data-state={d.state} data-x={cx} data-y={cy}>
              <title>{`${fmt.day(d.day)}: ${WORDS[d.state]}`}</title>
              <DaySymbol state={d.state} cx={cx} cy={cy} size={CELL} hatch={hatch} />
            </g>
          );
        })}
      </svg>
      <ul class="heat-key">
        {ORDER.map((s) => (
          <li key={s}>
            <svg class="heat-key-symbol" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <g data-state={s}>
                <DaySymbol state={s} cx={8} cy={8} size={16} hatch={hatch} />
              </g>
            </svg>
            {WORDS[s]}
          </li>
        ))}
      </ul>
    </div>
  );
}
