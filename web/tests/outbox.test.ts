import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { clearAccessToken, setAccessToken, Unauthorized } from '../src/api/auth';
import {
  closeDb,
  enqueue,
  EVENT_TYPES,
  type EventType,
  flush,
  InvalidEventError,
  openDb,
  pending,
  type SendFn,
} from '../src/sync/outbox';
import { uuidv7 } from '../src/sync/uuidv7';

interface SentEvent {
  id: string;
  type: string;
  payload: unknown;
  occurred_at: string;
  tz: string;
}

// Payload shapes follow the server (`api/yawmi/events/project.py`): the client only checks that a
// payload is a plain object, the server owns the per-type fields.
const HABIT = { habit_code: 'h-1', status: 'done' };

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

describe('event types', () => {
  it('are exactly the closed set the server accepts (EventType in api/yawmi/events/project.py)', () => {
    expect([...EVENT_TYPES]).toEqual([
      'habit_logged',
      'habit_skipped',
      'habit_vacation',
      'day_closed',
      'focus_started',
      'focus_ended',
      'breath_ended',
      'mood_logged',
      'confounder_tagged',
      'app_opened',
    ]);
  });
});

describe('enqueue', () => {
  it('stores a UUIDv7-keyed record with an ISO timestamp (ms, Z) and the Riyadh zone', async () => {
    const id = await enqueue('habit_logged', HABIT, new Date('2026-11-09T23:30:00.123Z'));

    expect(id[14]).toBe('7');
    const db = await openDb();
    expect(await db.get('outbox', id)).toEqual({
      id,
      type: 'habit_logged',
      payload: HABIT,
      occurred_at: '2026-11-09T23:30:00.123Z',
      tz: 'Asia/Riyadh',
    });
  });

  it('defaults occurred_at to now', async () => {
    const before = Date.now();
    const id = await enqueue('app_opened', {});
    const db = await openDb();
    const record = await db.get('outbox', id);
    const at = Date.parse(record?.occurred_at ?? '');
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('gives increasing ids in call order, even within one millisecond', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) ids.push(await enqueue('app_opened', { i }));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it('accepts every type the server knows', async () => {
    for (const type of EVENT_TYPES) await enqueue(type, {});
    expect(await pending()).toBe(EVENT_TYPES.length);
  });

  it.each(['habit.logged', 'sleep.logged', 'HABIT_LOGGED', 'habit_logged ', '', 'toString', '__proto__'])(
    'rejects the unknown type %j before anything reaches IndexedDB',
    async (type) => {
      const error = await enqueue(type as EventType, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidEventError);
      expect(await pending()).toBe(0);
    },
  );

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'x'],
    ['a number', 7],
    ['undefined', undefined],
    ['a Date', new Date()],
    ['a Map', new Map()],
    ['a class instance', new (class Box {})()],
  ])('rejects %s as a payload before anything reaches IndexedDB', async (_name, payload) => {
    const error = await enqueue('habit_logged', payload as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidEventError);
    expect(await pending()).toBe(0);
  });

  it('accepts a plain object, including one without a prototype', async () => {
    await enqueue('mood_logged', { mood: 3 });
    await enqueue('mood_logged', Object.assign(Object.create(null) as Record<string, unknown>, { mood: 4 }));
    expect(await pending()).toBe(2);
  });

  it('does not use up an id slot when it rejects an event', async () => {
    const before = await enqueue('app_opened', {});
    await enqueue('nope' as EventType, {}).catch(() => undefined);
    const after = await enqueue('app_opened', {});
    expect(after > before).toBe(true);
    expect(await pending()).toBe(2);
  });

  it('keeps ids increasing across a reload, even when the clock stepped back', async () => {
    // An event queued earlier carries a timestamp ahead of this clock (the clock was moved back).
    const queued = uuidv7(Date.now() + 3_600_000);
    const db = await openDb();
    await db.add('outbox', {
      id: queued,
      type: 'app_opened',
      payload: {},
      occurred_at: new Date().toISOString(),
      tz: 'Asia/Riyadh',
    });
    closeDb();

    // "Reload": a fresh module instance has no in-memory state, only what is in IndexedDB.
    vi.resetModules();
    const fresh = await import('../src/sync/outbox');
    const id = await fresh.enqueue('app_opened', {});

    expect(id > queued).toBe(true);
    expect(await fresh.pending()).toBe(2);
    fresh.closeDb();
  });
});

describe('flush', () => {
  it('keeps everything when the network fails, then sends the same ids and empties the queue', async () => {
    const ids = [
      await enqueue('habit_logged', { n: 1 }),
      await enqueue('habit_logged', { n: 2 }),
      await enqueue('breath_ended', { n: 3 }),
    ];
    send
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok({ accepted: 3, duplicates: 0 }));

    expect(await flush(100, send)).toEqual({ sent: 0, offline: true });
    expect(await pending()).toBe(3);

    expect(await flush(100, send)).toEqual({ sent: 3, offline: false });
    expect(await pending()).toBe(0);

    expect(send).toHaveBeenCalledTimes(2);
    expect(sentEvents(send.mock.calls[0]).map((e) => e.id)).toEqual(ids);
    expect(sentEvents(send.mock.calls[1]).map((e) => e.id)).toEqual(ids);
  });

  it('tells an empty queue apart from being offline', async () => {
    expect(await flush(100, send)).toEqual({ sent: 0, offline: false });
    expect(send).not.toHaveBeenCalled();

    await enqueue('app_opened', {});
    send.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await flush(100, send)).toEqual({ sent: 0, offline: true });
  });

  it('posts {events: [...]} to /v1/events as JSON, with the full record of each event', async () => {
    const id = await enqueue('habit_logged', { habit_code: 'h-1', status: 'done' }, new Date('2026-11-10T04:00:00.000Z'));
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
          type: 'habit_logged',
          payload: { habit_code: 'h-1', status: 'done' },
          occurred_at: '2026-11-10T04:00:00.000Z',
          tz: 'Asia/Riyadh',
        },
      ],
    });
  });

  it('shares one request between two concurrent flushes', async () => {
    await enqueue('habit_logged', { n: 1 });
    await enqueue('habit_logged', { n: 2 });
    await enqueue('habit_logged', { n: 3 });
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

    expect(await Promise.all([a, b])).toEqual([
      { sent: 3, offline: false },
      { sent: 3, offline: false },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await pending()).toBe(0);
  });

  it('allows a new flush once the previous one has settled', async () => {
    await enqueue('habit_logged', { n: 1 });
    send.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok());
    await flush(100, send);
    expect(await flush(100, send)).toEqual({ sent: 1, offline: false });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps pending events across a closed and reopened database', async () => {
    const id = await enqueue('habit_logged', { n: 1 });
    await enqueue('habit_logged', { n: 2 });

    // The app is closed: the connection goes away, the data stays.
    closeDb();

    expect(await pending()).toBe(2);
    const db = await openDb();
    expect((await db.getAllKeys('outbox'))[0]).toBe(id);

    send.mockResolvedValueOnce(ok());
    expect(await flush(100, send)).toEqual({ sent: 2, offline: false });
    expect(await pending()).toBe(0);
  });

  it('sends only the oldest events up to the batch size', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await enqueue('habit_logged', { i }));
    send.mockResolvedValueOnce(ok());

    expect(await flush(2, send)).toEqual({ sent: 2, offline: false });

    expect(sentEvents(send.mock.calls[0]).map((e) => e.id)).toEqual(ids.slice(0, 2));
    expect(await pending()).toBe(3);
    const db = await openDb();
    expect(await db.getAllKeys('outbox')).toEqual(ids.slice(2));
  });

  it('keeps events enqueued while a flush is in flight', async () => {
    const first = await enqueue('habit_logged', { n: 1 });
    let release!: (res: Response) => void;
    send.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    const inFlight = flush(100, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = await enqueue('habit_logged', { n: 2 });
    release(ok());
    await inFlight;

    const db = await openDb();
    expect(await db.getAllKeys('outbox')).toEqual([second]);
    expect(first).not.toBe(second);
  });

  it('keeps everything and throws on a non-200 answer', async () => {
    await enqueue('habit_logged', { n: 1 });
    send.mockResolvedValueOnce(new Response('{"detail":"boom"}', { status: 500 }));
    await expect(flush(100, send)).rejects.toThrow(/500/);
    expect(await pending()).toBe(1);

    send.mockResolvedValueOnce(new Response('{"detail":[]}', { status: 422 }));
    await expect(flush(100, send)).rejects.toThrow(/422/);
    expect(await pending()).toBe(1);
  });

  it('keeps everything when a 200 answer has no parsable body', async () => {
    await enqueue('habit_logged', { n: 1 });
    send.mockResolvedValueOnce(new Response('<html>captive portal</html>', { status: 200 }));
    await expect(flush(100, send)).rejects.toThrow();
    expect(await pending()).toBe(1);

    send.mockResolvedValueOnce(new Response('null', { status: 200 }));
    await expect(flush(100, send)).rejects.toThrow();
    expect(await pending()).toBe(1);
  });

  it('keeps everything and rethrows when the session is gone (Unauthorized)', async () => {
    await enqueue('habit_logged', { n: 1 });
    send.mockRejectedValueOnce(new Unauthorized());
    await expect(flush(100, send)).rejects.toBeInstanceOf(Unauthorized);
    expect(await pending()).toBe(1);
  });

  it('goes through authedFetch by default: a 401 refreshes the token and the retry empties the queue', async () => {
    setAccessToken('old');
    const id = await enqueue('habit_logged', { n: 1 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response('{"detail":"غير مصرّح"}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ device_id: 'd', access_token: 'new', refresh_token: null }), { status: 200 }),
      )
      .mockResolvedValueOnce(ok({ accepted: 1, duplicates: 0 }));

    expect(await flush()).toEqual({ sent: 1, offline: false });

    const urls = fetchMock.mock.calls.map((c: readonly unknown[]) => String(c[0]));
    expect(urls).toEqual(['/v1/events', '/v1/auth/refresh', '/v1/events']);
    const retryHeaders = new Headers(((fetchMock.mock.calls[2] ?? [])[1] as RequestInit).headers);
    expect(retryHeaders.get('Authorization')).toBe('Bearer new');
    expect(sentEvents(fetchMock.mock.calls[2]).map((e) => e.id)).toEqual([id]);
    expect(await pending()).toBe(0);
  });

  it('reports a refresh outage (5xx) as a rejection and keeps the queue', async () => {
    setAccessToken('old');
    await enqueue('habit_logged', { n: 1 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response('{"detail":"غير مصرّح"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));

    await expect(flush()).rejects.toThrow(/503/);
    expect(await pending()).toBe(1);
  });
});
