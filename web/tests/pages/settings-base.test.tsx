// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
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
