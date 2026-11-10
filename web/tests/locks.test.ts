import { afterEach, describe, expect, it, vi } from 'vitest';

import { LockTimeout, withLock } from '../src/lib/locks';

const stubLocks = (request: (...args: unknown[]) => Promise<unknown>) =>
  vi.stubGlobal('navigator', { locks: { request } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('withLock', () => {
  it('runs the task directly when the browser has no Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    expect(await withLock('x', () => Promise.resolve(7))).toBe(7);
  });

  it('runs the task directly when the lock request itself is refused before the task started', async () => {
    stubLocks(() => Promise.reject(new DOMException('storage is blocked', 'SecurityError')));
    const task = vi.fn(() => Promise.resolve('ran'));
    expect(await withLock('x', task)).toBe('ran');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs the task directly when requesting the lock throws synchronously', async () => {
    stubLocks(() => {
      throw new TypeError('locks unavailable');
    });
    expect(await withLock('x', () => Promise.resolve(1))).toBe(1);
  });

  it("passes the task's own failure through, without running it a second time", async () => {
    stubLocks((_name, _options, callback) => (callback as () => Promise<unknown>)());
    const task = vi.fn(() => Promise.reject(new Error('task failed')));
    await expect(withLock('x', task)).rejects.toThrow('task failed');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after waitMs with LockTimeout, and never runs the task', async () => {
    // A holder that never lets go: the request settles only through its signal.
    stubLocks(
      (_name, options) =>
        new Promise((_resolve, reject) => {
          const signal = (options as { signal?: AbortSignal }).signal;
          signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        }),
    );
    const task = vi.fn(() => Promise.resolve(1));
    const error = await withLock('x', task, { waitMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LockTimeout);
    expect(task).not.toHaveBeenCalled();
  });

  it('passes no signal when no wait bound is given', async () => {
    let seen: unknown;
    stubLocks((_name, options, callback) => {
      seen = options;
      return (callback as () => Promise<unknown>)();
    });
    await withLock('x', () => Promise.resolve(1));
    expect(seen).toEqual({});
  });
});
