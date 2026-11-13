import './focus-charts.css';
import { topHour } from '../focus/calc';
import { fmt } from '../lib/format';
import { x } from './rtl';

export interface HourBarsProps {
  /** 24 values: minutes of focus for each hour of the Riyadh day, hour 0 first (`hourBins`). */
  bins: number[];
}

const W = 320;
const H = 130;
const TOP = 20; // room for the number over the highest bar
const BASE = 100; // the baseline; the hour labels sit under it
const LABELLED = [0, 6, 12, 18];

const two = { minimumIntegerDigits: 2 };
/** «10:00», in the digits of the setting. The clock never flips: it is text. */
export const hourText = (hour: number): string => `${fmt.num(hour, two)}:${fmt.num(0, two)}`;

/** The 24 hours of the day as bars, hour 0 at the inline start (the right edge). The highest hour
 *  is the dark bar and carries its minutes; every bar has a tooltip. The label names the highest
 *  hour, so the picture is never the only way to read it. */
export function HourBars({ bins }: HourBarsProps) {
  const top = topHour(bins);
  const max = top?.minutes ?? 0;
  const label =
    top === null
      ? 'توزيع ساعات التركيز: لا بيانات بعد'
      : `توزيع ساعات التركيز: أكثر ساعة تركيزاً ${hourText(top.hour)} بـ${fmt.count(Math.round(top.minutes), 'minute')}`;
  const bar = Math.min(10, (W / 24) * 0.62);
  return (
    <svg class="chart hour-bars" role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} focusable="false">
      <line class="hour-base" x1="0" y1={BASE} x2={W} y2={BASE} />
      {bins.slice(0, 24).map((minutes, hour) => {
        const height = max > 0 ? Math.max(2, (minutes / max) * (BASE - TOP)) : 2;
        const isTop = top !== null && hour === top.hour;
        const centre = x(hour, 24, W);
        return (
          <rect
            key={hour}
            class={isTop ? 'hour-bar hour-bar-top' : 'hour-bar'}
            x={centre - bar / 2}
            y={BASE - height}
            width={bar}
            height={height}
            rx={Math.min(3, bar / 2)}
          >
            <title>{minutes > 0 ? `${hourText(hour)} · ${fmt.count(Math.round(minutes), 'minute')}` : `${hourText(hour)} · بلا تركيز`}</title>
          </rect>
        );
      })}
      {top !== null && (
        <text class="hour-value" x={x(top.hour, 24, W)} y={TOP - 5} direction="rtl" text-anchor="middle">
          {fmt.num(Math.round(top.minutes))}
        </text>
      )}
      {LABELLED.map((hour) => (
        <text key={hour} class="hour-tick" x={x(hour, 24, W)} y={BASE + 16} direction="ltr" text-anchor="middle">
          {fmt.num(hour, two)}
        </text>
      ))}
    </svg>
  );
}
