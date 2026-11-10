// Cross-tab mutual exclusion with the Web Locks API (`navigator.locks`). Two open tabs (or a tab
// and an installed PWA window) share the cookie jar and the IndexedDB, so the token refresh and the
// outbox flush must not run in two of them at once. Where the API is missing, or refuses the
// request before the task started (an opaque origin, blocked storage), `task` simply runs: callers
// keep their own in-tab single flight, which is the whole protection in that case.

interface LockManagerLike {
  request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T>;
}

/** `withLock` stopped waiting: another tab has held the lock longer than `waitMs`. The task did not run. */
export class LockTimeout extends Error {
  constructor(name: string) {
    super(`gave up waiting for the lock ${JSON.stringify(name)}`);
    this.name = 'LockTimeout';
  }
}

function lockManager(): LockManagerLike | undefined {
  try {
    const locks = (globalThis.navigator as { locks?: Partial<LockManagerLike> } | undefined)?.locks;
    return typeof locks?.request === 'function' ? (locks as LockManagerLike) : undefined;
  } catch {
    return undefined;
  }
}

export interface LockOptions {
  /** Stop waiting for the lock after this long and reject with `LockTimeout`. No bound when absent. */
  waitMs?: number;
}

/**
 * Run `task` while holding the exclusive lock `name`. Waits for the lock (at most `waitMs` when
 * given), or runs `task` directly without Web Locks. A failure of `task` itself passes through.
 */
export async function withLock<T>(name: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const locks = lockManager();
  if (!locks) return task();

  const signal = options.waitMs === undefined ? undefined : AbortSignal.timeout(options.waitMs);
  let started = false;
  const run = (): Promise<T> => {
    started = true;
    return task();
  };
  try {
    return await locks.request(name, signal ? { signal } : {}, run);
  } catch (error) {
    if (started) throw error;
    if (signal?.aborted) throw new LockTimeout(name);
    // The lock manager refused before the task ran: run it without the cross-tab lock.
    return task();
  }
}
