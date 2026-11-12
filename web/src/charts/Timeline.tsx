import './timeline.css';
import { toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import { fmt } from '../lib/format';
import type { CycleOut, MilestoneFull } from '../goals/types';
import { PLAN_END, PLAN_START } from '../goals/types';
import { x } from './rtl';
import { emptyLabel } from './scale';

export interface TimelineProps {
  cycles: CycleOut[];
  milestones: MilestoneFull[];
  today: Day;
  /** What the chart shows, in Arabic. */
  label: string;
}

// Geometry. The plan runs from 2026-10-31 (the right edge of the plot, where reading starts) to
// 2031-12-31 (the left edge). A right gutter holds the outcome codes of the lanes.
const W = 960;
const GUTTER = 44;
const PAD_END = 24;
const PLOT = W - GUTTER - PAD_END;
const AXIS_H = 56;
const CYCLE_H = 20;
const LANE_H = 22;
const TOP = AXIS_H + CYCLE_H + 14;

const START = toOrdinal(PLAN_START);
const SPAN = toOrdinal(PLAN_END) - START;

/** The horizontal position of a day: every day of the plan is one slot of the plot, slot 0 at the
 *  start (the right), through x() of rtl.ts. Days outside the plan are held at the nearest end. */
function xOf(day: Day): number {
  const index = Math.min(SPAN, Math.max(0, toOrdinal(day) - START));
  return PAD_END + x(index, SPAN + 1, PLOT);
}

type PointState = 'done' | 'open' | 'late';

const STATE_WORDS: Record<PointState, string> = { done: 'منجزة', open: 'مفتوحة', late: 'متأخرة' };
const STATES: PointState[] = ['done', 'open', 'late'];

function stateOf(m: MilestoneFull, today: Day): PointState {
  if (m.done) return 'done';
  return m.due_date !== null && toOrdinal(m.due_date) < toOrdinal(today) ? 'late' : 'open';
}

/** One milestone's symbol: a filled circle (done), a hollow circle (open), a diamond (late). */
function Mark({ state, cx, cy }: { state: PointState; cx: number; cy: number }) {
  if (state === 'done') return <circle class="tl-done" cx={cx} cy={cy} r="5" />;
  if (state === 'open') return <circle class="tl-open" fill="none" cx={cx} cy={cy} r="4.5" />;
  return <path class="tl-late" fill="none" d={`M${cx} ${cy - 6}L${cx + 6} ${cy}L${cx} ${cy + 6}L${cx - 6} ${cy}Z`} />;
}

let hijriStarts: { day: Day; year: string }[] | undefined;

/** The first day of each Umm al-Qura year inside the plan, found by reading every day once. */
function hijriYearStarts(): { day: Day; year: string }[] {
  if (hijriStarts) return hijriStarts;
  const format = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const found: { day: Day; year: string }[] = [];
  for (let ord = START; ord <= START + SPAN; ord += 1) {
    const date = new Date(ord * 86_400_000);
    const part = (type: string): string => format.formatToParts(date).find((p) => p.type === type)?.value ?? '';
    if (part('month') === '1' && part('day') === '1') found.push({ day: date.toISOString().slice(0, 10), year: part('year') });
  }
  hijriStarts = found;
  return found;
}

/** Each Gregorian year after the first starts on 1 January. */
function gregorianYearStarts(): { day: Day; year: string }[] {
  const first = Number(PLAN_START.slice(0, 4));
  const last = Number(PLAN_END.slice(0, 4));
  const out: { day: Day; year: string }[] = [];
  for (let y = first + 1; y <= last; y += 1) out.push({ day: `${y}-01-01`, year: String(y) });
  return out;
}

/** «دورة واحدة»، «دورتان»، «5 دورات»، «21 دورة». */
function cyclesText(n: number): string {
  if (n === 1) return 'دورة واحدة';
  if (n === 2) return 'دورتان';
  return n <= 10 ? `${fmt.num(n)} دورات` : `${fmt.num(n)} دورة`;
}

const codeNo = (code: string): number => Number(code.replace(/\D/g, '')) || 0;

/** The plan on one time axis: the cycles as bars, one lane per outcome with its milestones as points,
 *  years in both calendars, and today as a line. Horizontal order follows the reading direction. */
export function Timeline({ cycles, milestones, today, label }: TimelineProps) {
  if (cycles.length === 0 && milestones.length === 0) {
    return <svg class="chart timeline" role="img" aria-label={emptyLabel(label)} viewBox={`0 0 ${W} 40`} focusable="false" />;
  }

  const dated = milestones.filter((m) => m.due_date !== null);
  const undated = milestones.length - dated.length;
  const codes = [...new Set(dated.map((m) => m.outcome_code ?? ''))].sort((a, b) => {
    if (a === '' || b === '') return a === '' ? 1 : -1;
    return codeNo(a) - codeNo(b);
  });
  const lanes = new Map(codes.map((code, i) => [code, i]));
  const height = TOP + Math.max(1, codes.length) * LANE_H + 8;
  const done = milestones.filter((m) => m.done).length;
  const todayX = xOf(today);
  const years = gregorianYearStarts();
  const hijri = hijriYearStarts();
  const sentence =
    `${label}: ${cyclesText(cycles.length)}، ${fmt.num(done)} من ${fmt.num(milestones.length)} محطة منجزة، ` +
    `اليوم ${fmt.day(today)}`;
  const current = cycles.find((c) => toOrdinal(today) >= toOrdinal(c.start_date) && toOrdinal(today) <= toOrdinal(c.end_date));

  return (
    <div class="timeline-wrap">
      <section class="timeline-scroll" aria-label={`${label}، قابل للتمرير`} tabIndex={0}>
        <svg
          class="chart timeline"
          role="img"
          aria-label={sentence}
          viewBox={`0 0 ${W} ${height}`}
          width={W}
          height={height}
          focusable="false"
        >
          {years.map((y) => (
            <line key={y.year} class="timeline-grid" x1={xOf(y.day)} x2={xOf(y.day)} y1={AXIS_H - 6} y2={height} />
          ))}
          {years.map((y) => (
            <text key={`g${y.year}`} class="timeline-year" x={xOf(y.day)} y="14" text-anchor="middle" direction="rtl">
              {y.year}
            </text>
          ))}
          {hijri.map((y) => (
            <text key={`h${y.year}`} class="timeline-hijri" x={xOf(y.day)} y="31" text-anchor="middle" direction="rtl">
              {`${y.year} هـ`}
            </text>
          ))}

          {cycles.map((c) => {
            const right = xOf(c.start_date);
            const left = xOf(c.end_date);
            const isNow = current?.cycle_no === c.cycle_no;
            const width = Math.max(2, right - left - 1);
            return (
              <g key={c.cycle_no}>
                <rect
                  class={isNow ? 'timeline-cycle timeline-cycle-now' : 'timeline-cycle'}
                  data-cycle={c.cycle_no}
                  x={left}
                  y={AXIS_H}
                  width={width}
                  height={CYCLE_H}
                  rx="4"
                >
                  <title>{`الدورة ${fmt.num(c.cycle_no)} · ${c.theme} · ${fmt.day(c.start_date)} إلى ${fmt.day(c.end_date)}`}</title>
                </rect>
                {width >= 18 && (
                  <text
                    class={isNow ? 'timeline-cycle-no timeline-cycle-no-now' : 'timeline-cycle-no'}
                    x={left + width / 2}
                    y={AXIS_H + CYCLE_H / 2 + 4}
                    text-anchor="middle"
                    direction="rtl"
                  >
                    {fmt.num(c.cycle_no)}
                  </text>
                )}
              </g>
            );
          })}

          {codes.map((code, i) => (
            <g key={code}>
              <line class="timeline-lane" x1={PAD_END} x2={W - GUTTER + 8} y1={TOP + i * LANE_H + LANE_H / 2} y2={TOP + i * LANE_H + LANE_H / 2} />
              <text class="timeline-lane-label" x={W - GUTTER / 2 + 4} y={TOP + i * LANE_H + LANE_H / 2 + 4} text-anchor="middle" direction="rtl">
                {code === '' ? '—' : code}
              </text>
            </g>
          ))}

          {dated.map((m) => {
            const state = stateOf(m, today);
            const cx = xOf(m.due_date as Day);
            const cy = TOP + (lanes.get(m.outcome_code ?? '') ?? 0) * LANE_H + LANE_H / 2;
            return (
              <g key={m.page_id} data-milestone={m.page_id} data-state={state} data-x={cx}>
                <title>{`${m.title} · ${STATE_WORDS[state]} · ${fmt.day(m.due_date as Day)}`}</title>
                <Mark state={state} cx={cx} cy={cy} />
              </g>
            );
          })}

          <line
            class="timeline-today"
            data-x={todayX}
            aria-label={`اليوم: ${fmt.day(today)}`}
            x1={todayX}
            x2={todayX}
            y1={AXIS_H - 6}
            y2={height}
          />
          <text class="timeline-today-label" x={todayX} y={AXIS_H - 10} text-anchor="middle" direction="rtl">
            اليوم
          </text>
        </svg>
      </section>
      <ul class="timeline-key">
        {STATES.map((s) => (
          <li key={s}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <Mark state={s} cx={8} cy={8} />
            </svg>
            {STATE_WORDS[s]}
          </li>
        ))}
      </ul>
      {undated > 0 && <p class="timeline-note">{`${fmt.num(undated)} محطة بلا موعد لا تظهر على الخط.`}</p>}
    </div>
  );
}
