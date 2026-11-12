import { dayKey } from '../domain/days';
import type { Day } from '../domain/types';

const RIYADH_TZ = 'Asia/Riyadh';
const RIYADH_OFFSET_MS = 180 * 60_000; // +3 hours
const MS_PER_DAY = 86_400_000;

/**
 * Returns the calendar day (`YYYY-MM-DD`) in Asia/Riyadh for `now` (defaulting to current time).
 * Uses pure UTC instant arithmetic, never the browser's local time zone.
 */
export function todayRiyadh(now: Date = new Date()): Day {
  return dayKey(now.toISOString(), RIYADH_TZ);
}

/**
 * Calls `cb(newDay)` whenever midnight arrives in Asia/Riyadh while the page is open.
 * Returns an unsubscribe function that cleans up the timer and event listeners.
 */
export function onDayChange(cb: (day: Day) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentDay = todayRiyadh();

  function schedule() {
    const now = Date.now();
    const riyadhMs = now + RIYADH_OFFSET_MS;
    const nextMidnightRiyadh = (Math.floor(riyadhMs / MS_PER_DAY) + 1) * MS_PER_DAY;
    const nextMidnightUtc = nextMidnightRiyadh - RIYADH_OFFSET_MS;
    // +10ms safety buffer so we safely cross into the new day
    const delay = Math.max(nextMidnightUtc - now + 10, 50);

    timer = setTimeout(() => {
      const nextDay = todayRiyadh();
      if (nextDay !== currentDay) {
        currentDay = nextDay;
        cb(currentDay);
      }
      schedule();
    }, delay);
  }

  schedule();

  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      const nextDay = todayRiyadh();
      if (nextDay !== currentDay) {
        currentDay = nextDay;
        cb(currentDay);
      }
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}
