// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { kvSet } from '../../src/data/cache';
import { setDigits } from '../../src/lib/format';
import SettingsPage from '../../src/pages/settings/index';
import { closeDb } from '../../src/sync/outbox';
import { type IndicatorServer, SETTINGS, withIndicators } from '../helpers/indicator-fixtures';

// «الأهداف الرقمية»: the two numbers the design leaves empty until the person sets them (ruling 19):
// the daily focus minutes and the weekly breathing minutes. Each is a whole number from 5 to 600, or
// empty for «no target». The section saves with its own button, like every settings section.

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

async function open(settings: Partial<typeof SETTINGS> = {}, failWrites?: number): Promise<HTMLElement> {
  server = withIndicators(fetchMock, { settings, failWrites });
  render(<SettingsPage />);
  return screen.findByRole('region', { name: 'الأهداف الرقمية' });
}

const patches = (): unknown[] => server.called('PATCH', '/v1/settings').map((c) => c.body);
const FOCUS = 'هدف دقائق التركيز اليومي';
const BREATH = 'هدف دقائق التنفّس الأسبوعي';
const type = (section: HTMLElement, label: string, value: string): boolean =>
  fireEvent.input(within(section).getByLabelText(label), { target: { value } });
const save = (section: HTMLElement): boolean => fireEvent.click(within(section).getByRole('button', { name: 'حفظ الأهداف' }));
const saveButton = (section: HTMLElement): HTMLButtonElement => within(section).getByRole('button', { name: 'حفظ الأهداف' }) as HTMLButtonElement;

describe('settings: الأهداف الرقمية', () => {
  it('shows both fields empty by default, with the limits in words', async () => {
    const section = await open();
    expect((within(section).getByLabelText(FOCUS) as HTMLInputElement).value).toBe('');
    expect((within(section).getByLabelText(BREATH) as HTMLInputElement).value).toBe('');
    expect(within(section).getAllByText(/من 5 إلى 600 دقيقة/).length).toBeGreaterThan(0);
    expect(saveButton(section).disabled).toBe(true); // nothing changed yet
  });

  it('shows the saved numbers', async () => {
    const section = await open({ focus_daily_target_min: 90, breath_weekly_target_min: 30 });
    expect((within(section).getByLabelText(FOCUS) as HTMLInputElement).value).toBe('90');
    expect((within(section).getByLabelText(BREATH) as HTMLInputElement).value).toBe('30');
  });

  it('saves the weekly breathing target alone: 30 goes in the patch and nothing else', async () => {
    const section = await open();
    type(section, BREATH, '30');
    save(section);
    await screen.findByText('تم الحفظ');
    expect(patches()).toEqual([{ breath_weekly_target_min: 30 }]);
  });

  it('saves the daily focus target alone: 90', async () => {
    const section = await open();
    type(section, FOCUS, '90');
    save(section);
    await screen.findByText('تم الحفظ');
    expect(patches()).toEqual([{ focus_daily_target_min: 90 }]);
  });

  it('both together in one patch', async () => {
    const section = await open();
    type(section, FOCUS, '120');
    type(section, BREATH, '45');
    save(section);
    await screen.findByText('تم الحفظ');
    expect(patches()).toEqual([{ focus_daily_target_min: 120, breath_weekly_target_min: 45 }]);
  });

  it('emptying a saved field sends null', async () => {
    const section = await open({ breath_weekly_target_min: 30, focus_daily_target_min: 60 });
    type(section, BREATH, '');
    save(section);
    await screen.findByText('تم الحفظ');
    expect(patches()).toEqual([{ breath_weekly_target_min: null }]);
  });

  it('the limits are 5 and 600: both ends are taken', async () => {
    const section = await open();
    type(section, FOCUS, '5');
    type(section, BREATH, '600');
    save(section);
    await screen.findByText('تم الحفظ');
    expect(patches()).toEqual([{ focus_daily_target_min: 5, breath_weekly_target_min: 600 }]);
  });

  it.each(['4', '601', '0', '-10', '5.5', '12abc', '1e3'])('«%s» is refused before anything is sent, with the reason', async (bad) => {
    const section = await open();
    type(section, BREATH, bad);
    expect(within(section).getByText('الهدف عدد صحيح من 5 إلى 600 دقيقة')).toBeTruthy();
    expect(within(section).getByLabelText(BREATH).getAttribute('aria-invalid')).toBe('true');
    expect(saveButton(section).disabled).toBe(true);
    save(section);
    expect(patches()).toEqual([]);
  });

  it('a refused field holds back the other one too, and the error goes when the number is right', async () => {
    const section = await open();
    type(section, FOCUS, '60');
    type(section, BREATH, '4');
    expect(saveButton(section).disabled).toBe(true);
    type(section, BREATH, '40');
    expect(within(section).queryByText('الهدف عدد صحيح من 5 إلى 600 دقيقة')).toBeNull();
    expect(saveButton(section).disabled).toBe(false);
  });

  it('a failed save says so and keeps the numbers', async () => {
    const section = await open({}, 500);
    type(section, BREATH, '30');
    save(section);
    await screen.findByText(/تعذّر الحفظ/);
    expect((within(section).getByLabelText(BREATH) as HTMLInputElement).value).toBe('30');
  });

  it('without a connection the fields and the button are disabled, with «يحتاج اتصالاً»', async () => {
    setOnline(false);
    server = withIndicators(fetchMock);
    render(<SettingsPage />);
    const section = await screen.findByRole('region', { name: 'الأهداف الرقمية' });
    expect((within(section).getByLabelText(FOCUS) as HTMLInputElement).disabled).toBe(true);
    expect((within(section).getByLabelText(BREATH) as HTMLInputElement).disabled).toBe(true);
    expect(saveButton(section).disabled).toBe(true);
    expect(within(section).getByText('يحتاج اتصالاً')).toBeTruthy();
    expect(patches()).toEqual([]);
  });
});
