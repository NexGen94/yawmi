/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import { fromOrdinal, toOrdinal, weekdayOf } from '../domain/days';
import type { Day } from '../domain/types';
import { fmt } from '../lib/format';
import { x } from './rtl';
import './year-grid.css';

export interface YearGridProps {
  year: number;
  /** The days that have a mood, one score (1 to 5) a day. */
  days: readonly { day: Day; score: number }[];
  /** What the grid says to a screen reader: the year, the days with a mood and their average. */
  label: string;
}

const SCORES = [1, 2, 3, 4, 5] as const;
const CELL = 12;
const GAP = 3;
const ROWS = 7;

/** The five grades are five lightnesses of one blue: the fill opacity of the cell, never another hue
 *  (and never red). The word and the number of the grade are in the key and in each day's title. */
export const SHADES: Readonly<Record<number, number>> = { 1: 0.2, 2: 0.4, 3: 0.6, 4: 0.8, 5: 1 };

/** The words beside a grade in the key: the two ends say what they are. */
function keyWord(score: number): string {
  if (score === 1) return `${fmt.num(score)} الأدنى`;
  if (score === 5) return `${fmt.num(score)} الأعلى`;
  return fmt.num(score);
}

const shade = (score: number): number => SHADES[Math.min(5, Math.max(1, Math.round(score)))] ?? SHADES[3] ?? 0.6;

/** The mood of a year as a calendar of weeks (a column a week, Sunday on top, the first week at the
 *  right edge), with a text key under it. Only the days with a mood are shaded; the others stay empty
 *  outlines. */
export function YearGrid({ year, days, label }: YearGridProps) {
  const first = toOrdinal(`${String(year).padStart(4, '0')}-01-01`);
  const length = toOrdinal(`${String(year + 1).padStart(4, '0')}-01-01`) - first;
  const lead = weekdayOf(first);
  const columns = Math.floor((lead + length - 1) / ROWS) + 1;
  const slot = CELL + GAP;
  const width = columns * slot - GAP;
  const height = ROWS * slot - GAP;
  const scores = new Map(days.map((d) => [d.day, d.score]));

  const cells = [];
  for (let k = 0; k < length; k += 1) {
    const day = fromOrdinal(first + k);
    const column = Math.floor((lead + k) / ROWS);
    const row = (lead + k) % ROWS;
    const cx = x(column, columns, width + GAP) - GAP / 2;
    const left = cx - CELL / 2;
    const top = row * slot;
    const score = scores.get(day);
    cells.push(
      score === undefined ? (
        <rect key={day} class="year-empty" data-day={day} x={left} y={top} width={CELL} height={CELL} rx="3" />
      ) : (
        <rect
          key={day}
          class="year-cell"
          data-day={day}
          data-score={score}
          fill-opacity={shade(score)}
          x={left}
          y={top}
          width={CELL}
          height={CELL}
          rx="3"
        >
          <title>{`${fmt.dayShort(day)}: ${fmt.num(score)}`}</title>
        </rect>
      ),
    );
  }

  return (
    <div class="year-grid">
      <svg class="chart year-svg" role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} focusable="false">
        {cells}
      </svg>
      <ul class="year-key" aria-label="مفتاح درجات المزاج">
        {SCORES.map((score) => (
          <li key={score}>
            <svg class="year-key-swatch" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <rect class="year-cell" fill-opacity={SHADES[score]} x="1" y="1" width="14" height="14" rx="3" />
            </svg>
            {keyWord(score)}
          </li>
        ))}
      </ul>
      <p class="year-note">الخانة الفارغة يوم بلا تسجيل للمزاج</p>
    </div>
  );
}
