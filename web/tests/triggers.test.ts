import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFlushTriggers } from '../src/sync/triggers';

// The module only needs `document` and `window` as event targets, so plain EventTargets stand
// in for them and the suite stays in the node environment.
let doc: EventTarget & { visibilityState: string };
let win: EventTarget;
let uninstall: (() => void) | undefined;

beforeEach(() => {
  doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  win = new EventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.unstubAllGlobals();
});

describe('installFlushTriggers', () => {
  it('flushes once at install', () => {
    const flushFn = vi.fn().mockResolvedValue(0);
    uninstall = installFlushTriggers(flushFn);
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('flushes when the page becomes visible, and not when it is hidden', () => {
    const flushFn = vi.fn().mockResolvedValue(0);
    uninstall = installFlushTriggers(flushFn);
    flushFn.mockClear();

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(flushFn).not.toHaveBeenCalled();

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('flushes when the connection comes back', () => {
    const flushFn = vi.fn().mockResolvedValue(0);
    uninstall = installFlushTriggers(flushFn);
    flushFn.mockClear();

    win.dispatchEvent(new Event('online'));
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('calls the flush function without the event as an argument', () => {
    const flushFn = vi.fn().mockResolvedValue(0);
    uninstall = installFlushTriggers(flushFn);
    win.dispatchEvent(new Event('online'));
    expect(flushFn.mock.calls.every((args: unknown[]) => args.length === 0)).toBe(true);
  });

  it('is idempotent: a second install adds no listeners and no extra flush', () => {
    const flushFn = vi.fn().mockResolvedValue(0);
    const first = installFlushTriggers(flushFn);
    const second = installFlushTriggers(flushFn);
    uninstall = first;
    expect(flushFn).toHaveBeenCalledTimes(1);

    flushFn.mockClear();
    win.dispatchEvent(new Event('online'));
    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('stops reacting after uninstall, and can be installed again', () => {
    const flushFn = vi.fn().mockResolvedValue(0);
    const off = installFlushTriggers(flushFn);
    off();
    flushFn.mockClear();

    win.dispatchEvent(new Event('online'));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(flushFn).not.toHaveBeenCalled();

    uninstall = installFlushTriggers(flushFn);
    expect(flushFn).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event('online'));
    expect(flushFn).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed flush (events stay queued for the next trigger)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const flushFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      uninstall = installFlushTriggers(flushFn);
      win.dispatchEvent(new Event('online'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(flushFn).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('survives a flush function that throws synchronously', () => {
    const flushFn = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() => {
      uninstall = installFlushTriggers(flushFn);
    }).not.toThrow();
    expect(() => win.dispatchEvent(new Event('online'))).not.toThrow();
  });
});
