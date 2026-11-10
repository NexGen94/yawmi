// Cross-tab mutual exclusion with the Web Locks API (`navigator.locks`). Two open tabs (or a tab
// and an installed PWA window) share the cookie jar and the IndexedDB, so the token refresh and the
// outbox flush must not run in two of them at once. Where the API is missing, `task` simply runs:
// callers keep their own in-tab single flight, which is the whole protection in that case.

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function lockManager(): LockManagerLike | undefined {
  try {
    const locks = (globalThis.navigator as { locks?: Partial<LockManagerLike> } | undefined)?.locks;
    return typeof locks?.request === 'function' ? (locks as LockManagerLike) : undefined;
  } catch {
    return undefined;
  }
}

/** Run `task` while holding the exclusive lock `name` (waiting for it), or directly without Web Locks. */
export function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  return locks ? locks.request(name, task) : task();
}
