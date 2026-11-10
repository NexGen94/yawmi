import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { clearAccessToken, setAccessToken, Unauthorized } from '../src/api/auth';
import {
  BatchRejected,
  closeDb,
  enqueue,
  EVENT_TYPES,
  type EventType,
  flush,
  InvalidEventError,
  openDb,
  pending,
  quarantined,
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
  it('are exactly the server list (the EventIn type enum in openapi/openapi.json), in its order', () => {
    // Read at test time, not through the generated types, so a server change that nobody
    // regenerated still fails here.
    const spec = JSON.parse(readFileSync(new URL('../../openapi/openapi.json', import.meta.url), 'utf8')) as {
      components: { schemas: { EventIn: { properties: { type: { enum: string[] } } } } };
    };
    expect([...EVENT_TYPES]).toEqual(spec.components.schemas.EventIn.properties.type.enum);
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

  it('sends the oldest events first, in batches of the given size, until the queue is empty', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await enqueue('habit_logged', { i }));
    send.mockImplementation(() => Promise.resolve(ok()));

    expect(await flush(2, send)).toEqual({ sent: 5, offline: false });

    expect(send.mock.calls.map((call) => sentEvents(call).map((e) => e.id))).toEqual([
      ids.slice(0, 2),
      ids.slice(2, 4),
      ids.slice(4),
    ]);
    expect(await pending()).toBe(0);
  });

  it('drains more than 100 events in batches of 100 by default', async () => {
    for (let i = 0; i < 250; i += 1) await enqueue('app_opened', { i });
    send.mockImplementation(() => Promise.resolve(ok()));

    expect(await flush(undefined, send)).toEqual({ sent: 250, offline: false });
    expect(send.mock.calls.map((call) => sentEvents(call).length)).toEqual([100, 100, 50]);
    expect(await pending()).toBe(0);
  });

  it('stops draining at the first network failure and reports what was sent before it', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await enqueue('habit_logged', { i }));
    send.mockResolvedValueOnce(ok()).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    expect(await flush(2, send)).toEqual({ sent: 2, offline: true });
    expect(send).toHaveBeenCalledTimes(2);
    const db = await openDb();
    expect(await db.getAllKeys('outbox')).toEqual(ids.slice(2));
  });

  it('stops draining at the first refused batch and keeps the rest', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await enqueue('habit_logged', { i }));
    send.mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('', { status: 503 }));

    await expect(flush(2, send)).rejects.toThrow(/503/);
    expect(send).toHaveBeenCalledTimes(2);
    const db = await openDb();
    expect(await db.getAllKeys('outbox')).toEqual(ids.slice(2));
  });

  it('never sends more than the server allows in one batch (500)', async () => {
    for (let i = 0; i < 501; i += 1) await enqueue('app_opened', { i });
    send.mockImplementation(() => Promise.resolve(ok()));
    expect(await flush(10_000, send)).toEqual({ sent: 501, offline: false });
    expect(send.mock.calls.map((call) => sentEvents(call).length)).toEqual([500, 1]);
  });

  it('keeps events enqueued while a batch is in flight, and sends them in the next batch', async () => {
    const first = await enqueue('habit_logged', { n: 1 });
    const releases: ((res: Response) => void)[] = [];
    send.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );

    const inFlight = flush(100, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = await enqueue('habit_logged', { n: 2 });
    releases[0]?.(ok());

    // The acknowledgement of the first batch did not delete the event it did not carry.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const db = await openDb();
    expect(await db.getAllKeys('outbox')).toEqual([second]);
    releases[1]?.(ok());

    expect(await inFlight).toEqual({ sent: 2, offline: false });
    expect(sentEvents(send.mock.calls[0]).map((e) => e.id)).toEqual([first]);
    expect(sentEvents(send.mock.calls[1]).map((e) => e.id)).toEqual([second]);
    expect(await pending()).toBe(0);
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

const refused = (errors: { loc: (string | number)[]; type: string }[]): Response =>
  new Response(JSON.stringify({ detail: 'طلب غير صالح', errors }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  });

describe('quarantine', () => {
  it('moves the event the server names to quarantine and sends the rest of the batch', async () => {
    const ids = [
      await enqueue('habit_logged', { n: 0 }),
      await enqueue('habit_logged', { n: 1 }),
      await enqueue('habit_logged', { n: 2 }),
    ];
    send
      .mockResolvedValueOnce(refused([{ loc: ['body', 'events', 1, 'occurred_at'], type: 'datetime_parsing' }]))
      .mockResolvedValueOnce(ok({ accepted: 2, duplicates: 0 }));

    expect(await flush(100, send)).toEqual({ sent: 2, offline: false });

    expect(sentEvents(send.mock.calls[1]).map((e) => e.id)).toEqual([ids[0], ids[2]]);
    expect(await pending()).toBe(0);
    expect(await quarantined()).toBe(1);
    const db = await openDb();
    expect(await db.get('quarantine', ids[1] as string)).toMatchObject({
      id: ids[1],
      type: 'habit_logged',
      payload: { n: 1 },
      errors: [{ loc: ['body', 'events', 1, 'occurred_at'], type: 'datetime_parsing' }],
    });
  });

  it('quarantines every event the server names in one answer', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await enqueue('habit_logged', { i }));
    send
      .mockResolvedValueOnce(
        refused([
          { loc: ['body', 'events', 0, 'type'], type: 'literal_error' },
          { loc: ['body', 'events', 2], type: 'dict_type' },
          { loc: ['body', 'events', 2, 'id'], type: 'uuid_parsing' },
        ]),
      )
      .mockResolvedValueOnce(ok());

    expect(await flush(100, send)).toEqual({ sent: 2, offline: false });
    expect(sentEvents(send.mock.calls[1]).map((e) => e.id)).toEqual([ids[1], ids[3]]);
    expect(await quarantined()).toBe(2);
    const db = await openDb();
    expect(await db.getAllKeys('quarantine')).toEqual([ids[0], ids[2]]);
  });

  it('ends even if the server refuses every event in turn', async () => {
    for (let i = 0; i < 3; i += 1) await enqueue('habit_logged', { i });
    send.mockImplementation(() =>
      Promise.resolve(refused([{ loc: ['body', 'events', 0, 'payload'], type: 'dict_type' }])),
    );

    expect(await flush(100, send)).toEqual({ sent: 0, offline: false });
    expect(send).toHaveBeenCalledTimes(3);
    expect(await pending()).toBe(0);
    expect(await quarantined()).toBe(3);
  });

  it.each([
    ['a batch-level error', [{ loc: ['body', 'events'], type: 'too_long' }]],
    ['an index outside the batch', [{ loc: ['body', 'events', 7, 'type'], type: 'literal_error' }]],
    ['no errors at all', []],
    ['a location outside the events', [{ loc: ['body'], type: 'missing' }]],
    ['an index that is not an integer', [{ loc: ['body', 'events', '1', 'type'], type: 'literal_error' }]],
  ])('keeps everything, quarantines nothing and stops on %s', async (_name, errors) => {
    for (let i = 0; i < 3; i += 1) await enqueue('habit_logged', { i });
    send.mockResolvedValue(refused(errors));

    const error = await flush(100, send).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BatchRejected);
    expect((error as BatchRejected).status).toBe(422);
    expect(String(error)).toMatch(/422/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await pending()).toBe(3);
    expect(await quarantined()).toBe(0);
  });

  it('keeps everything and stops on a 422 whose body is not the server error shape', async () => {
    await enqueue('habit_logged', { n: 1 });
    send.mockResolvedValue(new Response('<html>proxy</html>', { status: 422 }));

    await expect(flush(100, send)).rejects.toBeInstanceOf(BatchRejected);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await pending()).toBe(1);
    expect(await quarantined()).toBe(0);
  });

  it('quarantines what it can attribute, then stops when the rest is refused for another reason', async () => {
    for (let i = 0; i < 3; i += 1) await enqueue('habit_logged', { i });
    send
      .mockResolvedValueOnce(
        refused([
          { loc: ['body', 'events', 1, 'type'], type: 'literal_error' },
          { loc: ['body', 'events'], type: 'too_long' },
        ]),
      )
      .mockResolvedValueOnce(refused([{ loc: ['body', 'events'], type: 'too_long' }]));

    await expect(flush(100, send)).rejects.toBeInstanceOf(BatchRejected);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await quarantined()).toBe(1);
    expect(await pending()).toBe(2);
  });

  it('keeps quarantined events across a closed and reopened database', async () => {
    await enqueue('habit_logged', { n: 1 });
    send.mockResolvedValueOnce(refused([{ loc: ['body', 'events', 0, 'type'], type: 'literal_error' }]));
    await flush(100, send);
    closeDb();
    expect(await quarantined()).toBe(1);
    expect(await pending()).toBe(0);
  });

  it('upgrades a version 1 database without losing queued events', async () => {
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('yawmi', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('outbox', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const id = uuidv7(Date.now());
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').add({
        id,
        type: 'app_opened',
        payload: {},
        occurred_at: new Date().toISOString(),
        tz: 'Asia/Riyadh',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacy.close();

    expect(await pending()).toBe(1);
    expect(await quarantined()).toBe(0);
    const db = await openDb();
    expect(db.version).toBe(2);
    expect(await db.getAllKeys('outbox')).toEqual([id]);
  });
});

describe('flush across tabs', () => {
  it('holds the outbox lock while it sends', async () => {
    const requested: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, task: () => Promise<unknown>) => {
          requested.push(name);
          return task();
        },
      },
    });
    await enqueue('app_opened', {});
    send.mockImplementation(() => Promise.resolve(ok()));

    expect(await flush(100, send)).toEqual({ sent: 1, offline: false });
    expect(requested).toEqual(['yawmi-outbox-flush']);
  });

  it('lets only one tab send a given event: the second waits for the first, then finds nothing left', async () => {
    for (let i = 0; i < 3; i += 1) await enqueue('habit_logged', { i });
    closeDb();

    // Two tabs: two module instances, one shared IndexedDB, and Node's real navigator.locks.
    vi.resetModules();
    const tabA = await import('../src/sync/outbox');
    vi.resetModules();
    const tabB = await import('../src/sync/outbox');
    let release!: (res: Response) => void;
    send.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    const a = tabA.flush(100, send);
    const b = tabB.flush(100, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);
    release(ok());

    expect(await a).toEqual({ sent: 3, offline: false });
    expect(await b).toEqual({ sent: 0, offline: false });
    expect(send).toHaveBeenCalledTimes(1);
    tabA.closeDb();
    tabB.closeDb();
  });

  it('still shares one in-tab flush when the browser has no Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    await enqueue('app_opened', {});
    send.mockImplementation(() => Promise.resolve(ok()));

    const [x, y] = await Promise.all([flush(100, send), flush(100, send)]);
    expect(x).toEqual({ sent: 1, offline: false });
    expect(y).toBe(x);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
