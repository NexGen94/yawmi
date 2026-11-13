// Hooks that read time. They return what the clock says; nothing counts ticks, so a tab whose timers
// stopped for a while (a sleeping tab) reads the right time at the next tick or when it is shown.

import { useEffect, useState } from 'preact/hooks';

/** How often the display looks at the clock. The phase and the remaining time are computed from the
 *  timestamps each time, so this only decides how soon a change is shown. */
export const TICK_MS = 200;

/** `Date.now()`, renewed every `TICK_MS` while `active`, and at once when the page is shown again. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = (): void => setNow(Date.now());
    tick();
    const timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active]);
  return now;
}

const REDUCED = '(prefers-reduced-motion: reduce)';

/** Whether the person asked the system for less motion (and when that changes). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (typeof window !== 'undefined' && window.matchMedia?.(REDUCED).matches) || false);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED);
    if (!query) return;
    const change = (): void => setReduced(query.matches);
    change();
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, []);
  return reduced;
}
