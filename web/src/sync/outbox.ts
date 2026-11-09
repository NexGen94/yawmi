// Offline outbox: every event is written to IndexedDB first and removed only after the server
// has acknowledged it, so a dropped connection or a closed app loses nothing. Resending is safe
// because the server treats an event id it already has as a duplicate (ON CONFLICT (id) DO NOTHING).

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import { authedFetch } from '../api/auth';
import { uuidv7 } from './uuidv7';

const DB_NAME = 'yawmi';
const DB_VERSION = 1;
const STORE = 'outbox';
const EVENTS_URL = '/v1/events';
const TIMEZONE = 'Asia/Riyadh';

export interface OutboxEvent {
  /** UUIDv7: sorts by creation time, and is the idempotency key on the server. */
  id: string;
  type: string;
  payload: unknown;
  /** When it happened (ISO 8601, milliseconds, `Z`), not when it was sent. */
  occurred_at: string;
  tz: string;
}

interface YawmiDB extends DBSchema {
  outbox: { key: string; value: OutboxEvent };
}

export type SendFn = (input: string, init: RequestInit) => Promise<Response>;

let dbPromise: Promise<IDBPDatabase<YawmiDB>> | null = null;

/** The shared connection, opened on first use. */
export function openDb(): Promise<IDBPDatabase<YawmiDB>> {
  dbPromise ??= openDB<YawmiDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE, { keyPath: 'id' });
    },
    blocking() {
      // A newer version of the app wants to upgrade: step aside.
      closeDb();
    },
    terminated() {
      // The browser dropped the connection (Safari does this); open a new one next time.
      dbPromise = null;
    },
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/** Close the shared connection. The data stays; the next call reopens it. */
export function closeDb(): void {
  const closing = dbPromise;
  dbPromise = null;
  void closing?.then((db) => db.close()).catch(() => undefined);
}

let lastIdTime = 0;

/** Queue an event. Resolves with its id once it is safely stored. */
export async function enqueue(type: string, payload: unknown, occurredAt: Date = new Date()): Promise<string> {
  // Ids are the queue order. Never reuse a millisecond so that events queued back to back keep
  // the order they were queued in.
  lastIdTime = Math.max(Date.now(), lastIdTime + 1);
  const id = uuidv7(lastIdTime);
  const event: OutboxEvent = { id, type, payload, occurred_at: occurredAt.toISOString(), tz: TIMEZONE };
  const db = await openDb();
  await db.add(STORE, event);
  return id;
}

/** How many events are waiting to be sent. */
export async function pending(): Promise<number> {
  return (await openDb()).count(STORE);
}

async function sendBatch(batch: number, send: SendFn): Promise<number> {
  const db = await openDb();
  const events = await db.getAll(STORE, null, batch);
  if (events.length === 0) return 0;

  let res: Response;
  try {
    res = await send(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  } catch (error) {
    // Offline or the connection dropped: not an error, everything stays queued for the next trigger.
    if (error instanceof TypeError) return 0;
    throw error;
  }

  if (res.status !== 200) throw new Error(`events rejected: HTTP ${res.status}`);
  // Delete only on an acknowledged answer that parses: a captive portal or proxy can answer 200
  // with something that is not the server's reply.
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null) throw new Error('events: unexpected response body');

  const tx = db.transaction(STORE, 'readwrite');
  for (const event of events) void tx.store.delete(event.id);
  await tx.done;
  return events.length;
}

let inFlight: Promise<number> | null = null;

/**
 * Send up to `batch` of the oldest events in one request and delete them once the server answers
 * 200. Concurrent callers share a single request. Resolves with the number of events sent: 0 when
 * the queue is empty or the network is down. Rejects (events kept) on `Unauthorized` or any
 * answer that is not a parsable 200.
 */
export function flush(batch = 100, send: SendFn = authedFetch): Promise<number> {
  inFlight ??= sendBatch(batch, send).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
