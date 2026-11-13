// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as cacheModule from '../../src/data/cache';
import { kvSet } from '../../src/data/cache';
import SettingsPage from '../../src/pages/settings/index';
import { NotificationsSection } from '../../src/pages/settings/NotificationsSection';
import { SessionSection } from '../../src/pages/settings/SessionSection';
import * as pushModule from '../../src/push/subscribe';
import { PUSH_UNSUPPORTED_MESSAGE } from '../../src/push/subscribe';
import { closeDb } from '../../src/sync/outbox';

describe('Settings Sections', () => {
  beforeEach(() => {
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  describe('SessionSection', () => {
    it('displays device name and sign-out button', () => {
      render(<SessionSection deviceName="متصفح الحاسوب" onLogout={vi.fn()} />);

      expect(screen.getByText('متصفح الحاسوب')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'خروج' })).toBeTruthy();
    });

    it('clicking "خروج" calls logout handler', () => {
      const logoutSpy = vi.fn();
      render(<SessionSection deviceName="متصفح الحاسوب" onLogout={logoutSpy} />);

      fireEvent.click(screen.getByRole('button', { name: 'خروج' }));
      expect(logoutSpy).toHaveBeenCalledTimes(1);
    });

    it('does not display "متصفح الحاسوب" when unpaired (deviceName omitted)', () => {
      render(<SessionSection onLogout={vi.fn()} />);

      expect(screen.queryByText('متصفح الحاسوب')).toBeNull();
      expect(screen.getByText('—')).toBeTruthy();
    });

    it('shows "تعذّر تسجيل الخروج" with role="alert" and retry button when logout fails', async () => {
      const logoutSpy = vi.fn().mockRejectedValueOnce(new Error('Logout failed')).mockResolvedValueOnce(undefined);
      render(<SessionSection deviceName="متصفح الحاسوب" onLogout={logoutSpy} />);

      fireEvent.click(screen.getByRole('button', { name: 'خروج' }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('تعذّر تسجيل الخروج');
      const retryBtn = screen.getByRole('button', { name: 'إعادة المحاولة' });
      expect(retryBtn).toBeTruthy();

      fireEvent.click(retryBtn);
      await vi.waitFor(() => {
        expect(logoutSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('NotificationsSection', () => {
    it('calls enablePush inside click handler of "تفعيل الإشعارات"', async () => {
      const enablePushSpy = vi.spyOn(pushModule, 'enablePush').mockResolvedValue('granted');

      render(<NotificationsSection />);

      const button = screen.getByRole('button', { name: 'تفعيل الإشعارات' });
      fireEvent.click(button);

      expect(enablePushSpy).toHaveBeenCalledTimes(1);
    });

    it('shows PUSH_UNSUPPORTED_MESSAGE when enablePush returns unsupported', async () => {
      vi.spyOn(pushModule, 'enablePush').mockResolvedValue('unsupported');

      render(<NotificationsSection />);

      fireEvent.click(screen.getByRole('button', { name: 'تفعيل الإشعارات' }));

      await screen.findByText(PUSH_UNSUPPORTED_MESSAGE);
    });
  });
});

describe('SettingsPage StateFrame states', () => {
  beforeEach(() => {
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
    // the page also reads the settings of the person; these tests do not serve them
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loading: shows skeleton / loading indicator', () => {
    const { container } = render(<SettingsPage state="loading" onRetry={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('جارٍ التحميل');
    expect(container.querySelector('.skeleton')).toBeTruthy();
  });

  it('error: shows error state and retry button', () => {
    const retrySpy = vi.fn();
    render(<SettingsPage state="error" onRetry={retrySpy} />);

    expect(screen.getByText('تعذّر التحميل')).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retryBtn);
    expect(retrySpy).toHaveBeenCalledTimes(1);
  });

  it('ready: renders session and notifications sections', () => {
    render(<SettingsPage state="ready" deviceName="متصفح الحاسوب" onRetry={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeTruthy();
    expect(screen.getByText('متصفح الحاسوب')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تفعيل الإشعارات' })).toBeTruthy();
  });

  it('offline with stale copy: renders sections with offline badge and disables online-required buttons', () => {
    render(
      <SettingsPage
        state="offline"
        stale={true}
        deviceName="متصفح الحاسوب"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText(/نسخة محفوظة · بلا اتصال/)).toBeTruthy();
    expect(screen.getByText('متصفح الحاسوب')).toBeTruthy();

    const pushBtn = screen.getByRole('button', { name: 'تفعيل الإشعارات' });
    expect(pushBtn.getAttribute('disabled')).not.toBeNull();
  });
});

describe('SettingsPage real route driving four states', () => {
  beforeEach(() => {
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loading: unpropped route shows loading state while reading storage', async () => {
    let finishRead!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    vi.spyOn(cacheModule, 'kvGet').mockImplementation(async () => {
      await gate;
      return null;
    });

    const { container } = render(<SettingsPage />);

    expect(screen.getByRole('status').textContent).toContain('جارٍ التحميل');
    expect(container.querySelector('.skeleton')).toBeTruthy();

    finishRead();
    await screen.findByRole('heading', { level: 1, name: 'الإعدادات' });
  });

  it('ready: unpropped route renders ready state with real device and enabled buttons', async () => {
    await kvSet('device_id', 'dev-real');
    await kvSet('device_name', 'متصفح العمل');

    render(<SettingsPage />);

    await screen.findByText('متصفح العمل');
    const logoutBtn = screen.getByRole('button', { name: 'خروج' });
    const pushBtn = screen.getByRole('button', { name: 'تفعيل الإشعارات' });
    expect(logoutBtn.getAttribute('disabled')).toBeNull();
    expect(pushBtn.getAttribute('disabled')).toBeNull();
  });

  it('offline: unpropped route detects offline, renders stale copy and disables buttons with "يحتاج اتصالاً"', async () => {
    await kvSet('device_id', 'dev-real');
    await kvSet('device_name', 'متصفح العمل');

    vi.stubGlobal('navigator', { onLine: false });

    render(<SettingsPage />);

    await screen.findByText(/نسخة محفوظة · بلا اتصال/);
    expect(screen.getByText('متصفح العمل')).toBeTruthy();

    const logoutBtn = screen.getByRole('button', { name: 'خروج' });
    const pushBtn = screen.getByRole('button', { name: 'تفعيل الإشعارات' });

    expect(logoutBtn.getAttribute('disabled')).not.toBeNull();
    expect(pushBtn.getAttribute('disabled')).not.toBeNull();

    // Verify both have "يحتاج اتصالاً"
    const hints = screen.getAllByText('يحتاج اتصالاً');
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });

  it('error: unpropped route displays error state when storage read fails, and retry button reloads', async () => {
    const kvSpy = vi.spyOn(cacheModule, 'kvGet').mockRejectedValueOnce(new Error('IDB read failure'));

    render(<SettingsPage />);

    await screen.findByText('تعذّر التحميل');
    const retryBtn = screen.getByRole('button', { name: 'إعادة المحاولة' });
    expect(retryBtn).toBeTruthy();

    kvSpy.mockResolvedValueOnce('dev-real').mockResolvedValueOnce('متصفح الحاسوب');
    fireEvent.click(retryBtn);

    await screen.findByText('متصفح الحاسوب');
  });
});
