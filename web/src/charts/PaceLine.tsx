import './pace.css';
import { toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import type { PaceOut } from '../goals/types';
import { fmt } from '../lib/format';
import { x } from './rtl';

export interface PaceLineProps {
  /** What `GET /v1/goals/{ref}/pace` returned. Nothing here is computed again: the line draws it. */
  pace: PaceOut;
  /** What the line follows, in Arabic. */
  label: string;
}

// Geometry: the start day is the right edge of the plot (where reading starts), the due day the left.
const W = 360;
const H = 180;
const PAD_START = 36;
const PAD_END = 36;
const PAD_TOP = 30;
const PAD_BOTTOM = 28;
const PLOT_W = W - PAD_START - PAD_END;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;

const num = (n: number): string => fmt.num(n, { maximumFractionDigits: 1 });

/** «45 يوماً حتى الموعد», «الموعد اليوم» or «تجاوز الموعد بـ5 أيام». */
export function daysLeftText(daysLeft: number): string {
  if (daysLeft > 0) return `${fmt.count(daysLeft, 'day')} حتى الموعد`;
  if (daysLeft === 0) return 'الموعد اليوم';
  return `تجاوز الموعد بـ${fmt.count(-daysLeft, 'day')}`;
}

/** The sentence a screen reader gets: the value, the expected value today, where the pace so far
 *  ends, and the days left. */
export function paceSentence(pace: PaceOut, label: string): string {
  const parts: string[] = [];
  parts.push(pace.current_value === null ? 'لا قراءة بعد' : `القيمة ${num(pace.current_value)}`);
  parts.push(`المتوقع اليوم ${num(pace.expected_today)}`);
  if (pace.projected_end !== null) parts.push(`المتوقع عند الموعد ${num(pace.projected_end)} من ${num(pace.target_value)}`);
  parts.push(daysLeftText(pace.days_left));
  return `${label}: ${parts.join('، ')}`;
}

/** The expected line (dashed, from the start value to the target) and the actual one (solid, from the
 *  readings), between the start day and the due day. With no reading only the expected line is drawn,
 *  and the chart says so; with nothing to measure there is no line at all. */
export function PaceLine({ pace, label }: PaceLineProps) {
  if (!(pace.target_value > 0)) {
    return <svg class="chart pace" role="img" aria-label={`${label}: لا ما يُقاس بعد`} viewBox={`0 0 ${W} 40`} focusable="false" />;
  }
  const start = toOrdinal(pace.start_day);
  const span = Math.max(1, toOrdinal(pace.due_day) - start);
  const xOf = (day: Day): number => {
    const index = Math.min(span, Math.max(0, toOrdinal(day) - start));
    return PAD_END + x(index, span + 1, PLOT_W);
  };
  const values = [pace.target_value, pace.expected_today, pace.current_value ?? 0, ...pace.readings.map((r) => r.value)];
  const top = Math.max(...values.filter(Number.isFinite), 1);
  const yOf = (v: number): number => PAD_TOP + (1 - Math.min(1, Math.max(0, v / top))) * PLOT_H;

  const right = xOf(pace.start_day);
  const left = xOf(pace.due_day);
  const readings = pace.readings.filter((r) => Number.isFinite(r.value));
  const actualPoints = readings.map((r) => `${xOf(r.day)},${yOf(r.value)}`).join(' ');
  const hasValue = pace.current_value !== null;
  const dotX = xOf(pace.today);
  const dotY = hasValue ? yOf(pace.current_value as number) : 0;
  const expectedY = yOf(pace.expected_today);
  // the word «الفعلي» sits on the side of the dot away from the expected line
  const wordY = hasValue ? (dotY <= expectedY ? dotY - 10 : dotY + 18) : 0;

  return (
    <svg class="chart pace" role="img" aria-label={paceSentence(pace, label)} viewBox={`0 0 ${W} ${H}`} focusable="false">
      <line class="pace-base" x1={left} x2={right} y1={yOf(0)} y2={yOf(0)} />
      <line class="pace-today" x1={dotX} x2={dotX} y1={PAD_TOP - 6} y2={yOf(0)} />
      <line
        class="pace-expected"
        x1={right}
        y1={yOf(pace.start_value)}
        x2={left}
        y2={yOf(pace.target_value)}
        stroke-dasharray="7 5"
      />
      <text class="pace-word" x={left} y={yOf(pace.target_value) - 10} text-anchor="middle" direction="rtl">
        المتوقع
      </text>
      <text class="pace-end" x={left} y={yOf(pace.target_value) + 18} text-anchor="middle" direction="rtl">
        {num(pace.target_value)}
      </text>
      <text class="pace-end" x={right} y={H - 8} text-anchor="middle" direction="rtl">
        {pace.start_day}
      </text>
      <text class="pace-end" x={left} y={H - 8} text-anchor="middle" direction="rtl">
        {pace.due_day}
      </text>
      {readings.length > 1 && <polyline class="pace-actual" fill="none" points={actualPoints} />}
      {hasValue && (
        <>
          <circle class="pace-dot" cx={dotX} cy={dotY} r="5" />
          <text class="pace-word pace-word-actual" x={dotX} y={wordY} text-anchor="middle" direction="rtl">
            الفعلي
          </text>
        </>
      )}
      {!hasValue && (
        <text class="pace-none" x={W / 2} y={H / 2 + 6} text-anchor="middle" direction="rtl">
          لا قراءة بعد
        </text>
      )}
    </svg>
  );
}
