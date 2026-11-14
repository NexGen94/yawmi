// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as navigateModule from '../../src/lib/navigate';
import PairPage from '../../src/pages/pair/index';
import { closeDb } from '../../src/sync/outbox';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('PairPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllGlobals();
  });

  it('renders heading, input field and submit button', () => {
    render(<PairPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'الإقران' })).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إقران هذا الجهاز' })).toBeTruthy();
  });

  it('disables button while submitting', async () => {
    let finishFetch!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishFetch = resolve;
      }),
    );

    render(<PairPage />);
    const input = screen.getByRole('textbox');
    const button = screen.getByRole('button', { name: 'إقران هذا الجهاز' });

    fireEvent.input(input, { target: { value: 'ABCD1234' } });
    fireEvent.click(button);

    expect(button.getAttribute('disabled')).not.toBeNull();

    finishFetch(json({ access_token: 'tok', device_id: 'd1', refresh_token: null }));
    await screen.findByRole('button');
  });

  it('shows "الكود غير صالح أو منتهٍ" on invalid code', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'الكود غير صالح أو منتهٍ' }, 400));

    render(<PairPage />);
    const input = screen.getByRole('textbox');
    const button = screen.getByRole('button', { name: 'إقران هذا الجهاز' });

    fireEvent.input(input, { target: { value: 'BAD' } });
    fireEvent.click(button);

    await screen.findByText('الكود غير صالح أو منتهٍ');
  });

  it('successful pair navigates to /', async () => {
    const navigateSpy = vi.spyOn(navigateModule, 'navigate');
    fetchMock.mockResolvedValueOnce(json({ access_token: 'tok', device_id: 'd1', refresh_token: null }));

    render(<PairPage />);
    const input = screen.getByRole('textbox');
    const button = screen.getByRole('button', { name: 'إقران هذا الجهاز' });

    fireEvent.input(input, { target: { value: 'GOODCODE' } });
    fireEvent.click(button);

    await vi.waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith('/');
    });
  });

  it('shows "تعذّر الاتصال" with role="alert" and "إعادة المحاولة" on network error, and disables retry when offline', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    render(<PairPage />);
    const input = screen.getByRole('textbox');
    const button = screen.getByRole('button', { name: 'إقران هذا الجهاز' });

    fireEvent.input(input, { target: { value: 'NETFAIL' } });
    fireEvent.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('تعذّر الاتصال');
    const retryBtn = screen.getByRole('button', { name: 'إعادة المحاولة' });
    expect(retryBtn).toBeTruthy();
    expect(retryBtn.getAttribute('disabled')).toBeNull();

    // While offline, retry button is disabled
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(retryBtn.getAttribute('disabled')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    fetchMock.mockResolvedValueOnce(json({ access_token: 'tok', device_id: 'd1', refresh_token: null }));
    fireEvent.click(retryBtn);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('shows "يحتاج اتصالاً" when offline', () => {
    vi.stubGlobal('navigator', { onLine: false });

    render(<PairPage />);
    expect(screen.getByText(/يحتاج اتصالاً/)).toBeTruthy();
  });
});
