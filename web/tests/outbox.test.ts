import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { clearAccessToken, setAccessToken, Unauthorized } from '../src/api/auth';
import { closeDb, enqueue, flush, openDb, pending, type SendFn } from '../src/sync/outbox';

interface SentEvent {
  id: string;
  type: string;
  payload: unknown;
  occurred_at: string;
  tz: string;
}

const ok = (body: unknown = { accepted: 0, duplicates: 0 }): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const sentEvents = (call: readonly unknown[] | undefined): SentEvent[] => {
  const init = (call?.[1] ?? {}) as RequestInit;
  return (JSON.parse(String(init.body)) as { events: SentEvent[] }).events;
};

let send: Mock<SendFn>;

beforeEach(() => {
  closeDb();
  // A fresh database per test: nothing leaks between scenarios.
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  send = vi.fn<SendFn>();
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  clearAccessToken();
});

describe('enqueue', () => {
  it('stores a UUIDv7-keyed record with an ISO timestamp (ms, Z) and the Riyadh zone', async () => {
    const id = await enqueue('habit.logged', { habit_id: 'h-1', value: 1 }, new Date('2026-11-09T23:30:00.123Z'));

    expect(id[14]).toBe('7');
    const db = await openDb();
    expect(await db.get('outbox', id)).toEqual({
      id,
      type: 'habit.logged',
      payload: { habit_id: 'h-1', value: 1 },
      occurred_at: '2026-11-09T23:30:00.123Z',
      tz: 'Asia/Riyadh',
    });
  });

  it('defaults occurred_at to now', async () => {
    const before = Date.now();
    const id = await enqueue('habit.logged', {});
    const db = await openDb();
    const record = await db.get('outbox', id);
    const at = Date.parse(record?.occurred_at ?? '');
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('gives increasing ids in call order, even within one millisecond', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) ids.push(await enqueue('habit.logged', { i }));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });
});

describe('flush', () => {
  it('keeps everything when the network fails, then sends the same ids and empties the queue', async () => {
    const ids = [
      await enqueue('habit.logged', { n: 1 }),
      await enqueue('habit.logged', { n: 2 }),
      await enqueue('sleep.logged', { n: 3 }),
    ];
    send
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok({ accepted: 3, duplicates: 0 }));

    expect(await flush(100, send)).toBe(0);
    expect(await pending()).toBe(3);

    expect(await flush(100, send)).toBe(3);
    expect(await pending()).toBe(0);

    expect(send).toHaveBeenCalledTimes(2);
    expect(sentEvents(send.mock.calls[0]).map((e) => e.id)).toEqual(ids);
    expect(sentEvents(send.mock.calls[1]).map((e) => e.id)).toEqual(ids);
  });

  it('posts {events: [...]} to /v1/events as JSON, with the full record of each event', async () => {
    const id = await enqueue('habit.logged', { habit_id: 'h-1' }, new Date('2026-11-10T04:00:00.000Z'));
    send.mockResolvedValueOnce(ok({ accepted: 1, duplicates: 0 }));

    await flush(100, send);

    const call = send.mock.calls[0] as readonly unknown[];
    expect(String(call[0])).toBe('/v1/events');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      events: [
        {
          id,
          type: 'habit.logged',
          payload: { habit_id: 'h-1' },
          occurred_at: '2026-11-10T04:00:00.000Z',
          tz: 'Asia/Riyadh',
        },
      ],
    });
  });

  it('shares one request between two concurrent flushes', async () => {
    await enqueue('habit.logged', { n: 1 });
    await enqueue('habit.logged', { n: 2 });
    await enqueue('habit.logged', { n: 3 });
    let release!: (res: Response) => void;
    send.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    const a = flush(100, send);
    const b = flush(100, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release(ok({ accepted: 3, duplicates: 0 }));

    expect(await Promise.all([a, b])).toEqual([3, 3]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await pending()).toBe(0);
  });

  it('allows a new flush once the previous one has settled', async () => {
    await enqueue('habit.logged', { n: 1 });
    send.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok());
    await flush(100, send);
    expect(await flush(100, send)).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps pending events across a closed and reopened database', async () => {
    const id = await enqueue('habit.logged', { n: 1 });
    await enqueue('habit.logged', { n: 2 });

    // The app is closed: the connection goes away, the data stays.
    closeDb();

    expect(await pending()).toBe(2);
    const db = await openDb();
    expect((await db.getAllKeys('outbox'))[0]).toBe(id);

    send.mockResolvedValueOnce(ok());
    expect(await flush(100, send)).toBe(2);
    expect(await pending()).toBe(0);
  });

  it('sends only the oldest events up to the batch size', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await enqueue('habit.logged', { i }));
    send.mockResolvedValueOnce(ok());

    expect(await flush(2, send)).toBe(2);

    expect(sentEvents(send.mock.calls[0]).map((e) => e.id)).toEqual(ids.slice(0, 2));
    expect(await pending()).toBe(3);
    const db = await openDb();
    expect(await db.getAllKeys('outbox')).toEqual(ids.slice(2));
  });

  it('does nothing, and makes no request, when the queue is empty', async () => {
    expect(await flush(100, send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps events enqueued while a flush is in flight', async () => {
    const first = await enqueue('habit.logged', { n: 1 });
    let release!: (res: Response) => void;
    send.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    const inFlight = flush(100, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = await enqueue('habit.logged', { n: 2 });
    release(ok());
    await inFlight;

    const db = await openDb();
    expect(await db.getAllKeys('outbox')).toEqual([second]);
    expect(first).not.toBe(second);
  });

  it('keeps everything and throws on a non-200 answer', async () => {
    await enqueue('habit.logged', { n: 1 });
    send.mockResolvedValueOnce(new Response('{"detail":"boom"}', { status: 500 }));
    await expect(flush(100, send)).rejects.toThrow(/500/);
    expect(await pending()).toBe(1);

    send.mockResolvedValueOnce(new Response('{"detail":[]}', { status: 422 }));
    await expect(flush(100, send)).rejects.toThrow(/422/);
    expect(await pending()).toBe(1);
  });

  it('keeps everything when a 200 answer has no parsable body', async () => {
    await enqueue('habit.logged', { n: 1 });
    send.mockResolvedValueOnce(new Response('<html>captive portal</html>', { status: 200 }));
    await expect(flush(100, send)).rejects.toThrow();
    expect(await pending()).toBe(1);

    send.mockResolvedValueOnce(new Response('null', { status: 200 }));
    await expect(flush(100, send)).rejects.toThrow();
    expect(await pending()).toBe(1);
  });

  it('keeps everything and rethrows when the session is gone (Unauthorized)', async () => {
    await enqueue('habit.logged', { n: 1 });
    send.mockRejectedValueOnce(new Unauthorized());
    await expect(flush(100, send)).rejects.toBeInstanceOf(Unauthorized);
    expect(await pending()).toBe(1);
  });

  it('goes through authedFetch by default: a 401 refreshes the token and the retry empties the queue', async () => {
    setAccessToken('old');
    const id = await enqueue('habit.logged', { n: 1 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response('{"detail":"غير مصرّح"}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ device_id: 'd', access_token: 'new', refresh_token: null }), { status: 200 }),
      )
      .mockResolvedValueOnce(ok({ accepted: 1, duplicates: 0 }));

    expect(await flush()).toBe(1);

    const urls = fetchMock.mock.calls.map((c: readonly unknown[]) => String(c[0]));
    expect(urls).toEqual(['/v1/events', '/v1/auth/refresh', '/v1/events']);
    const retryHeaders = new Headers(((fetchMock.mock.calls[2] ?? [])[1] as RequestInit).headers);
    expect(retryHeaders.get('Authorization')).toBe('Bearer new');
    expect(sentEvents(fetchMock.mock.calls[2]).map((e) => e.id)).toEqual([id]);
    expect(await pending()).toBe(0);
  });
});
