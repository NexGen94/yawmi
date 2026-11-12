// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAccessToken, LogoutError, setAccessToken } from '../../src/api/auth';
import { kvGet, readCache, writeCache } from '../../src/data/cache';
import { isPaired, logout, pairDevice } from '../../src/data/session';
import { closeDb, enqueue, openDb, pending, quarantined } from '../../src/sync/outbox';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('session and pairing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeDb();
    Object.assign(globalThis, { indexedDB: new IDBFactory() });
    clearAccessToken();
    window.confirm = vi.fn();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllGlobals();
  });

  it('pairDevice: wrong code throws PairError with "الكود غير صالح أو منتهٍ"', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'الكود غير صالح أو منتهٍ' }, 400));

    await expect(pairDevice('BADCODE')).rejects.toMatchObject({
      name: 'PairError',
      message: 'الكود غير صالح أو منتهٍ',
    });
    expect(await isPaired()).toBe(false);
  });

  it('pairDevice: success saves device_id to kv and sets isPaired to true', async () => {
    // Window width desktop: 1280
    window.innerWidth = 1280;
    fetchMock.mockResolvedValueOnce(
      json({ access_token: 'tok-123', device_id: 'dev-456', refresh_token: null }),
    );

    await pairDevice('GOODCODE');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call0 = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(call0[1]?.body));
    expect(body.code).toBe('GOODCODE');
    expect(body.name).toBe('متصفح الحاسوب');

    expect(await kvGet('device_id')).toBe('dev-456');
    expect(await kvGet('device_name')).toBe('متصفح الحاسوب');
    expect(await isPaired()).toBe(true);
  });

  it('pairDevice: saves "متصفح الجوال" when screen width is under 900px', async () => {
    window.innerWidth = 390;
    fetchMock.mockResolvedValueOnce(
      json({ access_token: 'tok-mob', device_id: 'dev-mob', refresh_token: null }),
    );

    await pairDevice('MOBCODE');

    const call0 = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(call0[1]?.body));
    expect(body.name).toBe('متصفح الجوال');
    expect(await kvGet('device_name')).toBe('متصفح الجوال');
  });

  it('logout() calls POST /v1/auth/logout once, clears access token, cache and device_id', async () => {
    setAccessToken('tok-live');
    await kvGet('device_id');
    const { kvSet } = await import('../../src/data/cache');
    await kvSet('device_id', 'dev-live');
    await writeCache('test-key', { data: 123 });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call0 = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(call0[0])).toBe('/v1/auth/logout');
    expect(await isPaired()).toBe(false);
    expect(await readCache('test-key')).toBeUndefined();
  });

  it('logout with 3 pending events tries flush first; if successful, logs out without prompt', async () => {
    await enqueue('habit_logged', { habit_code: 'h1', status: 'done' });
    await enqueue('habit_logged', { habit_code: 'h2', status: 'done' });
    await enqueue('habit_logged', { habit_code: 'h3', status: 'done' });
    expect(await pending()).toBe(3);

    const confirmSpy = vi.spyOn(window, 'confirm');

    // First call is flush (POST /v1/events) succeeding:
    fetchMock
      .mockResolvedValueOnce(json({ accepted: 3, duplicates: 0 }))
      // Second call is logout:
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await logout();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await pending()).toBe(0);
    expect(await isPaired()).toBe(false);
  });

  it('logout with 3 pending events prompts user when flush fails, and deletes queue if confirmed', async () => {
    await enqueue('habit_logged', { habit_code: 'h1', status: 'done' });
    await enqueue('habit_logged', { habit_code: 'h2', status: 'done' });
    await enqueue('habit_logged', { habit_code: 'h3', status: 'done' });
    expect(await pending()).toBe(3);

    // Flush fails (network offline / TypeError):
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    // Logout call:
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await logout();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('في الطابور 3 تسجيلات لم تُرسل. الخروج يحذفها.');
    expect(await pending()).toBe(0);
    expect(await isPaired()).toBe(false);
  });

  it('logout aborts when user cancels confirmation prompt for remaining events', async () => {
    const { kvSet } = await import('../../src/data/cache');
    await kvSet('device_id', 'dev-live');
    await enqueue('habit_logged', { habit_code: 'h1', status: 'done' });

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await logout();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Did not call /v1/auth/logout:
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the flush call
    expect(await pending()).toBe(1);
    expect(await isPaired()).toBe(true);
  });

  it('logout while offline rejects with LogoutError, keeps session and local data', async () => {
    const { kvSet } = await import('../../src/data/cache');
    await kvSet('device_id', 'dev-live');
    await writeCache('test-key', { data: 123 });
    await enqueue('habit_logged', { habit_code: 'h1', status: 'done' });

    vi.stubGlobal('navigator', { onLine: false });

    await expect(logout()).rejects.toBeInstanceOf(LogoutError);

    expect(await isPaired()).toBe(true);
    expect(await kvGet('device_id')).toBe('dev-live');
    expect(await readCache('test-key')).toBeDefined();
    expect(await pending()).toBe(1);
  });

  it('logout on server 500 rejects with LogoutError, keeps session and local data', async () => {
    const { kvSet } = await import('../../src/data/cache');
    await kvSet('device_id', 'dev-live');
    await writeCache('test-key', { data: 123 });

    fetchMock.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    await expect(logout()).rejects.toBeInstanceOf(LogoutError);

    expect(await isPaired()).toBe(true);
    expect(await kvGet('device_id')).toBe('dev-live');
    expect(await readCache('test-key')).toBeDefined();
  });

  it('logout on success clears quarantine in addition to cache and kv', async () => {
    const { kvSet } = await import('../../src/data/cache');
    await kvSet('device_id', 'dev-live');
    await writeCache('test-key', { data: 123 });

    // Place an item directly into quarantine store
    const db = await openDb();
    await db.add('quarantine', {
      id: '01931f3b-0001-7000-8000-000000000099',
      type: 'habit_logged',
      payload: {},
      occurred_at: new Date().toISOString(),
      tz: 'Asia/Riyadh',
      errors: [],
      quarantined_at: new Date().toISOString(),
    });
    expect(await quarantined()).toBe(1);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await logout();

    expect(await isPaired()).toBe(false);
    expect(await readCache('test-key')).toBeUndefined();
    expect(await quarantined()).toBe(0);
  });

  it.each([
    [1, 'في الطابور تسجيل واحد لم تُرسل. الخروج يحذفها.'],
    [2, 'في الطابور تسجيلان لم تُرسل. الخروج يحذفها.'],
    [3, 'في الطابور 3 تسجيلات لم تُرسل. الخروج يحذفها.'],
    [11, 'في الطابور 11 تسجيلاً لم تُرسل. الخروج يحذفها.'],
  ])('logout prompts with correct Arabic count phrasing for %i unsent events', async (count, expectedPrompt) => {
    for (let i = 0; i < count; i += 1) {
      await enqueue('habit_logged', { habit_code: `h${i}`, status: 'done' });
    }

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')); // flush fails
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })); // logout succeeds

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await logout();

    expect(confirmSpy).toHaveBeenCalledWith(expectedPrompt);
  });
});
