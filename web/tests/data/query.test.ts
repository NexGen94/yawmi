// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
