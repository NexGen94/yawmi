// When to try sending the outbox. No Background Sync (Safari has none): the app flushes at launch,
// when it comes back to the foreground, and when the connection returns.

import { flush } from './outbox';

export interface FlushTriggerOptions {
  /**
   * Called with every failure of a triggered flush: above all `Unauthorized` (the session is gone,
   * the shell shows pairing), and also `RefreshError` or `BatchRejected`. Being offline is not a
   * failure (`flush` resolves with `offline: true`). The events stay queued either way, and the
   * next trigger tries again; a handler that throws is ignored.
   */
  onError?: (error: unknown) => void;
}

let active: (() => void) | null = null;

/**
 * Flush now, on `visibilitychange` to visible, and on `online`. Returns the function that removes
 * the listeners. Calling it again while installed changes nothing and returns the same function
 * (the first options stay in force).
 */
export function installFlushTriggers(
  flushFn: () => Promise<unknown> = flush,
  options: FlushTriggerOptions = {},
): () => void {
  if (active !== null) return active;
  const { onError } = options;

  const report = (error: unknown): void => {
    try {
      onError?.(error);
    } catch {
      // a broken handler must not break the trigger
    }
  };
  const run = (): void => {
    try {
      void Promise.resolve(flushFn()).catch(report);
    } catch (error) {
      // flushFn threw synchronously: same treatment
      report(error);
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
