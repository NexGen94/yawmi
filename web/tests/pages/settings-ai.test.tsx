// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { kvSet } from '../../src/data/cache';
import SettingsPage from '../../src/pages/settings/index';
import { closeDb } from '../../src/sync/outbox';
import { coded, consent, json, memoryItem, settings, stubServer, type Handler, type MemoryItem } from '../helpers/ai-fixtures';

const setOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
};

beforeEach(async () => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  await kvSet('device_id', 'dev-1');
  await kvSet('device_name', 'متصفح الحاسوب');
});

afterEach(() => {
  setOnline(true);
  closeDb();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LENS = memoryItem('11111111-0000-7000-8000-000000000001', 'rule', 'اقرأ البيانات بعين الأسبوع لا اليوم');
const NOTE = memoryItem('22222222-0000-7000-8000-000000000002', 'note', 'القراءة أعلى في أيام المشي.');

function serve(over: Record<string, Handler> = {}, items: MemoryItem[] = [LENS, NOTE], attached = { mission: false, vision: false }) {
  return stubServer({
    'GET /v1/settings': () => json(settings()),
    'PATCH /v1/settings': (call) => json(settings(call.body as object)),
    'GET /v1/ai/consent': () => json(consent({ granted: true })),
    'GET /v1/ai/memory': () => json({ items, attached }),
    ...over,
  });
}

async function open(): Promise<void> {
  render(<SettingsPage />);
  await screen.findByText('ما يُرفق بكل طلب'); // the memory has been read
}

describe('settings: the AI section and what is attached to every request', () => {
  it('says in words what is attached to every request', async () => {
    serve();
    await open();
    const memory = screen.getByRole('region', { name: 'الذاكرة' });
    expect(within(memory).getByText('ما يُرفق بكل طلب')).toBeTruthy();
    // the numbers and words of the days, the active lenses, the saved notes (sent as data)
    expect(memory.textContent).toContain('الملاحظات المحفوظة');
    expect(memory.textContent).toContain('بيانات');
  });

  it('lists every saved note with its words, and the lenses in their own list', async () => {
    serve();
    await open();
    const notes = screen.getByRole('list', { name: 'الملاحظات المحفوظة' });
    expect(within(notes).getByText('القراءة أعلى في أيام المشي.')).toBeTruthy();
    const lenses = screen.getByRole('list', { name: 'العدسات' });
    expect(within(lenses).getByText('اقرأ البيانات بعين الأسبوع لا اليوم')).toBeTruthy();
  });

  it('says whether رسالتي and رؤيتي are attached', async () => {
    serve({ 'GET /v1/settings': () => json(settings({ mission: 'أبني حياة متزنة', vision: '' })) }, [LENS], { mission: true, vision: false });
    await open();
    const memory = screen.getByRole('region', { name: 'الذاكرة' });
    expect(memory.textContent).toMatch(/رسالتي[^]*تُرفق/);
    expect(memory.textContent).toContain('أبني حياة متزنة');
    expect(memory.textContent).toMatch(/رؤيتي[^]*لا تُرفق/);
  });

  it('deleting an item of the memory calls DELETE on it', async () => {
    const s = serve({ [`DELETE /v1/ai/memory/${NOTE.id}`]: () => new Response(null, { status: 204 }) });
    await open();
    const notes = screen.getByRole('list', { name: 'الملاحظات المحفوظة' });
    fireEvent.click(within(notes).getByRole('button', { name: /حذف/ }));
    await waitFor(() => expect(s.of('DELETE', `/v1/ai/memory/${NOTE.id}`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('القراءة أعلى في أيام المشي.')).toBeNull());
  });

  it('«إعادة ضبط كاملة» asks first, then calls DELETE /v1/ai/memory', async () => {
    const s = serve({ 'DELETE /v1/ai/memory': () => new Response(null, { status: 204 }) });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة ضبط كاملة' }));
    const dialog = await screen.findByRole('dialog');
    expect(s.of('DELETE', '/v1/ai/memory')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'حذف كل البنود' }));
    await waitFor(() => expect(s.of('DELETE', '/v1/ai/memory')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('القراءة أعلى في أيام المشي.')).toBeNull());
  });

  it('«إلغاء» on the reset calls nothing', async () => {
    const s = serve();
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة ضبط كاملة' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    expect(s.of('DELETE', '/v1/ai/memory')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('settings: the lenses', () => {
  it('adding a lens posts a rule', async () => {
    const s = serve({ 'POST /v1/ai/memory': (call) => json(memoryItem('33333333-0000-7000-8000-000000000003', 'rule', (call.body as { text: string }).text), 201) });
    await open();
    fireEvent.input(screen.getByLabelText('عدسة جديدة'), { target: { value: 'ركّز على الأسبوع' } });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة عدسة' }));
    await waitFor(() => expect(s.of('POST', '/v1/ai/memory')).toHaveLength(1));
    expect(s.of('POST', '/v1/ai/memory')[0]?.body).toEqual({ kind: 'rule', text: 'ركّز على الأسبوع' });
    expect(await screen.findByText('ركّز على الأسبوع')).toBeTruthy();
  });

  it('the field stops at 300 characters', async () => {
    serve();
    await open();
    const field = screen.getByLabelText('عدسة جديدة') as HTMLInputElement;
    fireEvent.input(field, { target: { value: 'ا'.repeat(350) } });
    expect(field.value).toHaveLength(300);
  });

  it('explains in one line that a diagnosis or therapy lens makes every reply out of scope', async () => {
    serve();
    await open();
    const lenses = screen.getByRole('region', { name: 'العدسات' });
    expect(lenses.textContent).toContain('خارج النطاق');
    expect(lenses.textContent).toMatch(/تشخيص|علاج/);
  });

  it('a lens can be switched off without being deleted (PATCH active)', async () => {
    const s = serve({ [`PATCH /v1/ai/memory/${LENS.id}`]: () => json({ ...LENS, active: false }) });
    await open();
    const lenses = screen.getByRole('list', { name: 'العدسات' });
    fireEvent.click(within(lenses).getByRole('switch', { name: /مفعّلة/ }));
    await waitFor(() => expect(s.of('PATCH', `/v1/ai/memory/${LENS.id}`)).toHaveLength(1));
    expect(s.of('PATCH', `/v1/ai/memory/${LENS.id}`)[0]?.body).toEqual({ active: false });
  });

  it('a full memory is said in the words of the server', async () => {
    serve({ 'POST /v1/ai/memory': () => coded(422, 'الذاكرة ممتلئة: 20 بنداً حدها', 'memory_full') });
    await open();
    fireEvent.input(screen.getByLabelText('عدسة جديدة'), { target: { value: 'س' } });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة عدسة' }));
    expect(await screen.findByText('الذاكرة ممتلئة: 20 بنداً حدها')).toBeTruthy();
  });
});

describe('settings: the style of the reply', () => {
  it('ai_lines to 1 patches the settings', async () => {
    const s = serve();
    await open();
    const group = screen.getByRole('radiogroup', { name: 'عدد السطور' });
    fireEvent.click(within(group).getByRole('radio', { name: 'سطر واحد' }));
    await waitFor(() => expect(s.of('PATCH', '/v1/settings')).toHaveLength(1));
    expect(s.of('PATCH', '/v1/settings')[0]?.body).toEqual({ ai_lines: 1 });
  });

  it('the tone and the place of the day summary patch too', async () => {
    const s = serve();
    await open();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'نبرة الرد' })).getByRole('radio', { name: 'مع الشرح' }));
    await waitFor(() => expect(s.of('PATCH', '/v1/settings')).toHaveLength(1));
    expect(s.of('PATCH', '/v1/settings')[0]?.body).toEqual({ ai_tone: 'explained' });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'موضع ملخص اليوم' })).getByRole('radio', { name: 'في الصباح' }));
    await waitFor(() => expect(s.of('PATCH', '/v1/settings')).toHaveLength(2));
    expect(s.of('PATCH', '/v1/settings')[1]?.body).toEqual({ ai_checkin: 'morning' });
  });
});

describe('settings: the consent', () => {
  it('names the provider and withdraws the consent with DELETE', async () => {
    const s = serve({ 'DELETE /v1/ai/consent': () => json(consent({ granted: false })) });
    await open();
    const section = screen.getByRole('region', { name: 'الذكاء الاصطناعي' });
    await within(section).findByText(/Anthropic/);
    fireEvent.click(within(section).getByRole('button', { name: 'سحب الموافقة' }));
    await waitFor(() => expect(s.of('DELETE', '/v1/ai/consent')).toHaveLength(1));
    expect(await within(section).findByText('الذكاء الاصطناعي متوقف حتى الموافقة')).toBeTruthy();
  });

  it('without a consent: «تفعيل الذكاء الاصطناعي» opens the dialog and «موافقة» puts it', async () => {
    const s = serve({
      'GET /v1/ai/consent': () => json(consent()),
      'PUT /v1/ai/consent': () => json(consent({ granted: true })),
    });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'تفعيل الذكاء الاصطناعي' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'موافقة' }));
    await waitFor(() => expect(s.of('PUT', '/v1/ai/consent')).toHaveLength(1));
    expect(s.of('PUT', '/v1/ai/consent')[0]?.body).toEqual({ provider: 'anthropic', personal_text: false });
    expect(await screen.findByRole('button', { name: 'سحب الموافقة' })).toBeTruthy();
  });

  it('the personal-text key can be turned on after the consent (PUT again with true)', async () => {
    const s = serve({ 'PUT /v1/ai/consent': (call) => json(consent({ granted: true, ...(call.body as object) })) });
    await open();
    const section = screen.getByRole('region', { name: 'الذكاء الاصطناعي' });
    const key = await within(section).findByRole('checkbox', { name: /رسالتي/ });
    expect((key as HTMLInputElement).checked).toBe(false);
    fireEvent.click(key);
    await waitFor(() => expect(s.of('PUT', '/v1/ai/consent')).toHaveLength(1));
    expect(s.of('PUT', '/v1/ai/consent')[0]?.body).toEqual({ provider: 'anthropic', personal_text: true });
  });

  it('offline the controls are off and say why', async () => {
    serve();
    setOnline(false);
    render(<SettingsPage />);
    const section = await screen.findByRole('region', { name: 'الذكاء الاصطناعي' });
    expect(within(section).getByText('يحتاج اتصالاً')).toBeTruthy();
    expect(((await within(section).findByRole('button', { name: 'سحب الموافقة' })) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('settings: the parked wording and the logout button (task 6)', () => {
  it('N-1: «خروج» is off on a device that is not paired', async () => {
    serve();
    // no device_id in kv
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
    render(<SettingsPage />);
    await screen.findByRole('heading', { level: 1, name: 'الإعدادات' });
    const logout = await screen.findByRole('button', { name: 'خروج' });
    expect((logout as HTMLButtonElement).disabled).toBe(true);
  });

  it('N-1: «خروج» works on a paired device', async () => {
    serve();
    render(<SettingsPage />);
    await screen.findByText('متصفح الحاسوب');
    expect((screen.getByRole('button', { name: 'خروج' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('N-2: offline with the device record only, the badge says «بلا اتصال» and not a saved copy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    setOnline(false);
    render(<SettingsPage />);
    await screen.findByText('بلا اتصال');
    expect(screen.queryByText(/نسخة محفوظة/)).toBeNull();
  });
});
