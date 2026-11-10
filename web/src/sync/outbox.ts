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

/**
 * The closed set of event types the server accepts (`EventType` in `api/yawmi/events/project.py`).
 * The server rejects a whole batch with a 422 if one event has any other type, so an unknown
 * type is refused here, before it can reach the queue and block every later send.
 * Replace with the generated `EventIn['type']` once `schema.d.ts` lands (16b).
 */
export const EVENT_TYPES = [
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
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The server requires a JSON object; the fields it expects depend on the type and are its to check. */
export type EventPayload = Record<string, unknown>;

export interface OutboxEvent {
  /** UUIDv7: sorts by creation time, and is the idempotency key on the server. */
  id: string;
  type: EventType;
  payload: EventPayload;
  /** When it happened (ISO 8601, milliseconds, `Z`), not when it was sent. */
  occurred_at: string;
  tz: string;
}

/** `flush` result. `offline` is true only when a request was attempted and the network failed. */
export interface FlushResult {
  sent: number;
  offline: boolean;
}

/** `enqueue` refused the event: an unknown type or a payload that is not a plain object. Nothing was stored. */
export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

interface YawmiDB extends DBSchema {
  outbox: { key: string; value: OutboxEvent };
}

export type SendFn = (input: string, init: RequestInit) => Promise<Response>;

let dbPromise: Promise<IDBPDatabase<YawmiDB>> | null = null;

/** The millisecond timestamp inside a UUIDv7, or NaN if `id` does not look like one. */
const idTime = (id: string): number => Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);

// Ids are the queue order, so the next id must never sort before one already issued.
let lastIdTime = 0;

/** Start the id clock from the newest queued id, so a reload (and a clock set back) keeps FIFO. */
async function seedIdClock(db: IDBPDatabase<YawmiDB>): Promise<void> {
  const cursor = await db.transaction(STORE).store.openCursor(null, 'prev');
  const newest = cursor ? idTime(cursor.key) : Number.NaN;
  if (Number.isFinite(newest)) lastIdTime = Math.max(lastIdTime, newest);
}

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
  })
    .then(async (db) => {
      try {
        await seedIdClock(db);
      } catch (error) {
        db.close();
        throw error;
      }
      return db;
    })
    .catch((error: unknown) => {
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

function isPlainObject(value: unknown): value is EventPayload {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Queue an event. Resolves with its id once it is safely stored. Rejects with `InvalidEventError`,
 * storing nothing, if `type` is not one of `EVENT_TYPES` or `payload` is not a plain object.
 */
export async function enqueue(type: EventType, payload: EventPayload, occurredAt: Date = new Date()): Promise<string> {
  if (!EVENT_TYPES.includes(type)) throw new InvalidEventError(`unknown event type: ${JSON.stringify(type)}`);
  if (!isPlainObject(payload)) throw new InvalidEventError('event payload must be a plain object');
  const occurred_at = occurredAt.toISOString();

  const db = await openDb();
  // Never reuse a millisecond, so that events queued back to back keep the order they were queued in.
  lastIdTime = Math.max(Date.now(), lastIdTime + 1);
  const id = uuidv7(lastIdTime);
  await db.add(STORE, { id, type, payload, occurred_at, tz: TIMEZONE });
  return id;
}

/** How many events are waiting to be sent. */
export async function pending(): Promise<number> {
  return (await openDb()).count(STORE);
}

async function sendBatch(batch: number, send: SendFn): Promise<FlushResult> {
  const db = await openDb();
  const events = await db.getAll(STORE, null, batch);
  if (events.length === 0) return { sent: 0, offline: false };

  let res: Response;
  try {
    res = await send(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  } catch (error) {
    // Offline or the connection dropped: not an error, everything stays queued for the next trigger.
    if (error instanceof TypeError) return { sent: 0, offline: true };
    throw error;
  }

  // Server contract (`post_events` in api/yawmi/routes/events.py): success is exactly HTTP 200
  // with `{accepted, duplicates}`. Anything else keeps the events. Deliberately strict: if the
  // route ever answers 201/202, change this together with the server, or the events would be
  // resent forever (harmless, since duplicates are ignored by id, but wasteful).
  if (res.status !== 200) throw new Error(`events rejected: HTTP ${res.status}`);
  // Delete only on an acknowledged answer that parses: a captive portal or proxy can answer 200
  // with something that is not the server's reply.
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null) throw new Error('events: unexpected response body');

  const tx = db.transaction(STORE, 'readwrite');
  for (const event of events) void tx.store.delete(event.id);
  await tx.done;
  return { sent: events.length, offline: false };
}

let inFlight: Promise<FlushResult> | null = null;

/**
 * Send up to `batch` of the oldest events in one request and delete them once the server answers
 * 200. Concurrent callers share a single request and its result. Resolves with how many events
 * were sent, and `offline: true` when the network was down (0 sent with `offline: false` means the
 * queue was empty). Rejects (events kept) on `Unauthorized` or any answer that is not a parsable 200.
 */
export function flush(batch = 100, send: SendFn = authedFetch): Promise<FlushResult> {
  inFlight ??= sendBatch(batch, send).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
