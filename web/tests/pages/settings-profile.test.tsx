// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { kvSet } from '../../src/data/cache';
import { setDigits } from '../../src/lib/format';
import SettingsPage from '../../src/pages/settings/index';
import { closeDb } from '../../src/sync/outbox';
import { type IndicatorServer, SETTINGS, withIndicators } from '../helpers/indicator-fixtures';

let fetchMock: ReturnType<typeof vi.fn>;
let server: IndicatorServer;

const setOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
};

beforeEach(async () => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await kvSet('device_id', 'dev-1');
  await kvSet('device_name', 'متصفح الحاسوب');
});

afterEach(() => {
  setDigits('latn');
  setOnline(true);
  closeDb();
  vi.unstubAllGlobals();
});

async function open(settings: Partial<typeof SETTINGS> = {}): Promise<void> {
  server = withIndicators(fetchMock, { settings });
  render(<SettingsPage />);
  await screen.findByRole('region', { name: 'رسالتي ورؤيتي' });
}

const patches = (): unknown[] => server.called('PATCH', '/v1/settings').map((c) => c.body);

describe('settings: رسالتي ورؤيتي', () => {
  it('shows the saved words, and «حفظ» patches the settings once with what changed', async () => {
    await open({ mission: 'نص قديم' });
    const field = screen.getByLabelText('رسالتي') as HTMLTextAreaElement;
    expect(field.value).toBe('نص قديم');
    fireEvent.input(field, { target: { value: 'أبني حياة متزنة' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ رسالتي ورؤيتي' }));
    await screen.findByText('تم الحفظ');
    expect(patches()).toEqual([{ mission: 'أبني حياة متزنة' }]);
  });

  it('the counter stops the text at 600 characters', async () => {
    await open();
    const field = screen.getByLabelText('رؤيتي') as HTMLTextAreaElement;
    fireEvent.input(field, { target: { value: 'ا'.repeat(650) } });
    expect(field.value).toHaveLength(600);
    expect(screen.getByText('600 / 600')).toBeTruthy();
  });

  it('writes nothing for the person: no suggestion anywhere in the section', async () => {
    await open();
    const section = screen.getByRole('region', { name: 'رسالتي ورؤيتي' });
    expect(within(section).queryByText(/اقتراح|مقترح/)).toBeNull();
    expect((screen.getByLabelText('رسالتي') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('رؤيتي') as HTMLTextAreaElement).value).toBe('');
  });

  it('a refused save says so and keeps the text', async () => {
    server = withIndicators(fetchMock, { failWrites: 500 });
    render(<SettingsPage />);
    await screen.findByRole('region', { name: 'رسالتي ورؤيتي' });
    fireEvent.input(screen.getByLabelText('رسالتي'), { target: { value: 'نص' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ رسالتي ورؤيتي' }));
    expect((await screen.findByRole('alert')).textContent).toContain('تعذّر الحفظ');
    expect((screen.getByLabelText('رسالتي') as HTMLTextAreaElement).value).toBe('نص');
  });
});

describe('settings: day reminders and the late notice', () => {
  it('the evening reminder at 21:00 sends day_reminders.evening, with the other two as they are', async () => {
    await open();
    fireEvent.input(screen.getByLabelText('وقت تذكير المساء'), { target: { value: '21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ تذكير المساء' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({
      day_reminders: { morning: null, evening: { time: '21:00', days_mask: 127 }, weekly: null },
    });
  });

  it('the daily late notice is on by default at 20:00', async () => {
    await open();
    const toggle = screen.getByRole('switch', { name: 'إشعار يومي بالمتأخرات' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect((screen.getByLabelText('وقت إشعار المتأخرات') as HTMLInputElement).value).toBe('20:00');
  });

  it('changing its time to 07:30 sends late_notice_time', async () => {
    await open();
    fireEvent.input(screen.getByLabelText('وقت إشعار المتأخرات'), { target: { value: '07:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ وقت الإشعار' }));
    await waitFor(() => expect(patches()).toEqual([{ late_notice_time: '07:30' }]));
  });

  it('switching it off sends late_notice_enabled: false', async () => {
    await open();
    fireEvent.click(screen.getByRole('switch', { name: 'إشعار يومي بالمتأخرات' }));
    await waitFor(() => expect(patches()).toEqual([{ late_notice_enabled: false }]));
    await waitFor(() => expect((screen.getByRole('switch', { name: 'إشعار يومي بالمتأخرات' }) as HTMLInputElement).checked).toBe(false));
  });

  it('says it works once the notifications are enabled, until they are', async () => {
    await open();
    expect(screen.getByText('يعمل بعد تفعيل الإشعارات')).toBeTruthy();
  });

  it('does not say it when the notifications are already enabled', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    await open();
    expect(screen.queryByText('يعمل بعد تفعيل الإشعارات')).toBeNull();
  });
});

describe('settings: the display and the shortcuts', () => {
  it('switching the digits to Arabic-Indic turns «12» into «١٢» on the page', async () => {
    await open();
    const sample = screen.getByTestId('digits-sample');
    expect(sample.textContent).toBe('12');
    fireEvent.click(screen.getByRole('radio', { name: 'أرقام هندية' }));
    await waitFor(() => expect(screen.getByTestId('digits-sample').textContent).toBe('١٢'));
    expect(patches()).toEqual([{ digits: 'arab' }]);
  });

  it('shows the shortcuts: Ctrl+K and /', async () => {
    await open();
    const section = screen.getByRole('region', { name: 'الاختصارات' });
    expect(within(section).getByText('Ctrl+K')).toBeTruthy();
    expect(within(section).getByText('/')).toBeTruthy();
  });

  it('without a connection the saves are disabled and say why', async () => {
    setOnline(false);
    server = withIndicators(fetchMock);
    render(<SettingsPage />);
    await screen.findByText(/نسخة محفوظة · بلا اتصال/);
    await screen.findByRole('region', { name: 'رسالتي ورؤيتي' });
    for (const name of ['حفظ رسالتي ورؤيتي', 'حفظ تذكير المساء', 'حفظ وقت الإشعار']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole('switch', { name: 'إشعار يومي بالمتأخرات' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText('يحتاج اتصالاً').length).toBeGreaterThanOrEqual(3);
  });
});
