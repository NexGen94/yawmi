import type { BreathSessionOut } from '../../breath/calc';
import { sessionDays, weekMinutes, weekSessionCount } from '../../breath/calc';
import { Ring } from '../../charts/Ring';
import { periodBounds } from '../../domain/periods';
import { fromOrdinal, toOrdinal } from '../../domain/days';
import type { Day, WeekStart } from '../../domain/types';
import { fmt } from '../../lib/format';

export interface WeekRingProps {
  sessions: readonly BreathSessionOut[];
  today: Day;
  weekStart: WeekStart;
  /** `breath_weekly_target_min`; without one the number stands alone. */
  target: number | null;
}

/** The seven days of the week of `today`, each with a mark by its shape (full or empty) and its words. */
export function SessionDots({ sessions, today, weekStart }: Omit<WeekRingProps, 'target'>) {
  const first = toOrdinal(periodBounds(today, 'week', weekStart).start);
  const done = new Set(sessionDays(sessions, today, weekStart));
  const days = Array.from({ length: 7 }, (_, i) => fromOrdinal(first + i));
  return (
    <ul class="session-dots" aria-label="جلسات الأسبوع">
      {days.map((day) => {
        const has = done.has(day);
        return (
          <li key={day} class="session-dot" data-done={has ? 'true' : 'false'} data-today={day === today ? 'true' : 'false'}>
            <svg class="session-dot-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle class={has ? 'dot-full' : 'dot-empty'} cx="8" cy="8" r="6" />
            </svg>
            <span class="visually-hidden">{`${fmt.day(day)}: ${has ? 'جلسة' : 'بلا جلسة'}`}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The minutes of the six styles this week: «18 من 30 دقيقة» with a ring when a weekly target is
 *  set, the number alone when it is not. The hold and exhale tests are not part of it. */
export function WeekRing({ sessions, today, weekStart, target }: WeekRingProps) {
  // Whole minutes, the same number in the words and in the ring, so «30 من 30» is never shown early.
  const minutes = Math.floor(weekMinutes(sessions, today, weekStart) + 1e-9);
  const count = weekSessionCount(sessions, today, weekStart);
  return (
    <div class="week-ring">
      {target !== null && <Ring value={minutes / target} label="دقائق التنفّس هذا الأسبوع" size={112} />}
      <div class="week-figures">
        <p class="week-minutes num">{target !== null ? `${fmt.num(minutes)} من ${fmt.count(target, 'minute')}` : fmt.count(minutes, 'minute')}</p>
        <p class="breath-note">{count === 0 ? 'بلا جلسات هذا الأسبوع' : `${fmt.count(count, 'session')} هذا الأسبوع`}</p>
      </div>
      <SessionDots sessions={sessions} today={today} weekStart={weekStart} />
    </div>
  );
}
