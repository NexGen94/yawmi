// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as cacheModule from '../../src/data/cache';
import { writeCache } from '../../src/data/cache';
import { useQuery } from '../../src/data/query';
import { closeDb } from '../../src/sync/outbox';

function QueryHarness<T>(props: {
  queryKey: string;
  fetcher: () => Promise<T>;
}) {
  const { data, state, stale, reload } = useQuery(props.queryKey, props.fetcher);

  return h(
    'div',
    null,
    h('div', { 'data-testid': 'state' }, state),
    h('div', { 'data-testid': 'stale' }, String(stale)),
    h('div', { 'data-testid': 'data' }, data !== undefined ? JSON.stringify(data) : ''),
    h('button', { type: 'button', onClick: reload }, 'إعادة'),
  );
}

describe('useQuery', () => {
  beforeEach(() => {
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
  });

  afterEach(() => {
    closeDb();
  });

  it('successful fetch writes cache, sets state ready, and stale false', async () => {
    const fetcher = vi.fn().mockResolvedValue({ message: 'مرحبا' });

    render(h(QueryHarness, { queryKey: 'test-key', fetcher }));

    expect(screen.getByTestId('state').textContent).toBe('loading');

    await screen.findByText('ready');
    expect(screen.getByTestId('stale').textContent).toBe('false');
    expect(screen.getByTestId('data').textContent).toBe(JSON.stringify({ message: 'مرحبا' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fetch throwing TypeError with a cached copy gives state offline, stale true, and cached data', async () => {
    await writeCache('cached-key', { message: 'نسخة سابقة' });

    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    render(h(QueryHarness, { queryKey: 'cached-key', fetcher }));

    await screen.findByText('offline');
    expect(screen.getByTestId('stale').textContent).toBe('true');
    expect(screen.getByTestId('data').textContent).toBe(JSON.stringify({ message: 'نسخة سابقة' }));
  });

  it('fetch throwing TypeError without cached copy gives state offline, data undefined', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    render(h(QueryHarness, { queryKey: 'empty-key', fetcher }));

    await screen.findByText('offline');
    expect(screen.getByTestId('stale').textContent).toBe('false');
    expect(screen.getByTestId('data').textContent).toBe('');
  });

  it('server 500 error gives state error', async () => {
    const fetcher = vi.fn().mockRejectedValue(Object.assign(new Error('Internal Server Error'), { status: 500 }));

    render(h(QueryHarness, { queryKey: 'error-key', fetcher }));

    await screen.findByText('error');
    expect(screen.getByTestId('stale').textContent).toBe('false');
  });

  it('reload() invokes fetcher again', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });

    render(h(QueryHarness, { queryKey: 'reload-key', fetcher }));

    await screen.findByText(JSON.stringify({ count: 1 }));

    fireEvent.click(screen.getByRole('button', { name: 'إعادة' }));

    await screen.findByText(JSON.stringify({ count: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('failed cache write does not discard successful fetch, showing data with state ready', async () => {
    vi.spyOn(cacheModule, 'writeCache').mockRejectedValue(new Error('QuotaExceededError'));
    const fetcher = vi.fn().mockResolvedValue({ message: 'نجاح بعد عطل التخزين' });

    render(h(QueryHarness, { queryKey: 'write-fail-key', fetcher }));

    await screen.findByText('ready');
    expect(screen.getByTestId('data').textContent).toBe(JSON.stringify({ message: 'نجاح بعد عطل التخزين' }));
    expect(screen.getByTestId('stale').textContent).toBe('false');
  });

  it('failed cache read while offline ends in offline with undefined data, never stuck on loading', async () => {
    vi.spyOn(cacheModule, 'readCache').mockRejectedValue(new Error('DatabaseCorrupted'));
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    render(h(QueryHarness, { queryKey: 'read-fail-key', fetcher }));

    await screen.findByText('offline');
    expect(screen.getByTestId('data').textContent).toBe('');
    expect(screen.getByTestId('stale').textContent).toBe('false');
  });

  it('refetches when the browser goes back online, and only while it shows the offline copy', async () => {
    vi.restoreAllMocks(); // the cache spies of the tests above stay installed
    await writeCache('online-key', { message: 'نسخة سابقة' });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ message: 'من الخادم' });

    render(h(QueryHarness, { queryKey: 'online-key', fetcher }));
    await screen.findByText('offline');
    expect(fetcher).toHaveBeenCalledTimes(1);

    fireEvent(window, new Event('online'));

    await screen.findByText('ready');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('stale').textContent).toBe('false');
    expect(screen.getByTestId('data').textContent).toBe(JSON.stringify({ message: 'من الخادم' }));

    // A page that is ready has nothing to refetch.
    fireEvent(window, new Event('online'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops listening for online when the page unmounts', async () => {
    vi.restoreAllMocks();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { unmount } = render(h(QueryHarness, { queryKey: 'unmount-key', fetcher }));
    await screen.findByText('offline');

    unmount();
    fireEvent(window, new Event('online'));

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
