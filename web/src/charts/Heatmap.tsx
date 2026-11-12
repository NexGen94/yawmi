import { useId } from 'preact/hooks';

import { fmt } from '../lib/format';
import { x } from './rtl';
import { emptyLabel } from './scale';

/** The four states of a scheduled or unscheduled day, and two more for habits judged by period:
 *  `none` is a past day with nothing logged that is not a miss (a weekly habit is judged on its
 *  week), and `future` is a day that has not come. The key and the sentence name a state only when a
 *  day has it, so a grid of the four base states reads as it always did. */
export type DayState = 'done' | 'missed' | 'skipped' | 'off' | 'none' | 'future';

export interface HeatmapProps {
  /** The days in order (ISO day and state), laid out as a calendar: rows of 7 from the right. */
  days: { day: string; state: DayState; /** Replaces the word of the state in the cell's tooltip. */ note?: string; /** Marks today with a ring. */ current?: boolean }[];
  /** What the grid shows, in Arabic. */
  label: string;
}

/** Each state has its own word and its own shape, so nothing is told by colour alone. */
const WORDS: Record<DayState, string> = {
  done: 'منجز',
  missed: 'لم يُنجز',
  skipped: 'متخطّى',
  off: 'غير مجدول',
  none: 'لا تسجيل',
  future: 'قادم',
};
const ORDER: DayState[] = ['done', 'missed', 'skipped', 'off', 'none', 'future'];
const BASE = 4;

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
    case 'none':
      return <circle class="heat-none" fill="none" cx={cx} cy={cy} r={size * 0.28} />;
    case 'future':
      return <rect class="heat-future" fill="none" x={start + 1} y={top + 1} width={size - 2} height={size - 2} rx="4" />;
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
  const counts: Record<DayState, number> = { done: 0, missed: 0, skipped: 0, off: 0, none: 0, future: 0 };
  for (const d of days) counts[d.state] += 1;
  // The four base states are always named; the others only when a day has them.
  const shown = ORDER.filter((s, i) => i < BASE || counts[s] > 0);
  const sentence =
    n === 0
      ? emptyLabel(label)
      : `${label}، ${fmt.count(n, 'day')}: ` +
        shown.map((s, i) => `${i === 0 ? '' : 'و'}${WORDS[s]} ${fmt.num(counts[s])}`).join('، ');

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
              <title>{`${fmt.day(d.day)}: ${d.note ?? WORDS[d.state]}`}</title>
              <DaySymbol state={d.state} cx={cx} cy={cy} size={CELL} hatch={hatch} />
              {d.current && (
                <rect class="heat-today" fill="none" x={cx - CELL / 2 - 2} y={cy - CELL / 2 - 2} width={CELL + 4} height={CELL + 4} rx="6" />
              )}
            </g>
          );
        })}
      </svg>
      <ul class="heat-key">
        {shown.map((s) => (
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
