// When to try sending the outbox. No Background Sync (Safari has none): the app flushes at launch,
// when it comes back to the foreground, and when the connection returns.

import { flush } from './outbox';

let active: (() => void) | null = null;

/**
 * Flush now, on `visibilitychange` to visible, and on `online`. Returns the function that removes
 * the listeners. Calling it again while installed changes nothing and returns the same function.
 */
export function installFlushTriggers(flushFn: () => Promise<unknown> = flush): () => void {
  if (active !== null) return active;

  const run = (): void => {
    // A failed flush leaves the events queued; the next trigger tries again.
    try {
      void Promise.resolve(flushFn()).catch(() => undefined);
    } catch {
      // flushFn threw synchronously: same treatment
    }
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') run();
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', run);
  run();

  active = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', run);
    active = null;
  };
  return active;
}
