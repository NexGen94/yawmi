// Offline outbox: every event is written to IndexedDB first and removed only after the server
// has acknowledged it, so a dropped connection or a closed app loses nothing. Resending is safe
// because the server treats an event id it already has as a duplicate (ON CONFLICT (id) DO NOTHING).
//
// The server refuses a whole batch (422) when one event in it is bad, naming the event's index in
// `errors[].loc`. Such an event is moved to a separate `quarantine` store, never dropped, so the
// events around it can still go. `quarantined()` counts them, `listQuarantined()` shows them and
// `requeue(id)` puts one back (a refusal can be the server's, e.g. a type it does not know yet).

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import { authedFetch } from '../api/auth';
import type { components } from '../api/schema';
import { LockTimeout, withLock } from '../lib/locks';
import { isAbortOrTimeout } from '../lib/timeout';
import { uuidv7 } from './uuidv7';

type Schemas = components['schemas'];

const DB_NAME = 'yawmi';
/** 1: `outbox`. 2: adds `quarantine` (existing queued events are kept by the upgrade). */
const DB_VERSION = 2;
const STORE = 'outbox';
const QUARANTINE = 'quarantine';
const EVENTS_URL = '/v1/events';
const TIMEZONE = 'Asia/Riyadh';
/** `EventBatch.events` has `maxItems: 500`; a longer batch is refused as a whole. */
const MAX_BATCH = 500;
/** Cross-tab lock name: one tab at a time reads, sends and deletes queued events. */
const FLUSH_LOCK = 'yawmi-outbox-flush';

/**
 * Bounds on a flush, in milliseconds. Each batch request is bounded because the drain runs under
 * the cross-tab lock (500 events fit in well under that on a live connection). A tab that waits
 * longer than `lockWaitMs` for another tab's flush gives up and reports nothing sent: the holder is
 * sending (or stuck), and the next trigger tries again. Mutable for tests only.
 */
export const flushTimeouts = { requestMs: 30_000, lockWaitMs: 30_000 };

/**
 * How long the upgrade may stay blocked by another tab's open connection before `openDb` gives up
 * and asks for a reload. A live old tab closes on `versionchange` at once (`blocking` below); one
 * that is suspended or frozen does not. Mutable for tests only.
 */
export const dbTimeouts = { blockedGraceMs: 5_000 };

/** The event types the server accepts: the `EventIn.type` enum of the generated schema. */
export type EventType = Schemas['EventIn']['type'];

/** The server requires a JSON object; the fields it expects depend on the type and are its to check. */
export type EventPayload = Schemas['EventIn']['payload'];

/** A queued event is exactly what `POST /v1/events` takes for one event. */
export type OutboxEvent = Schemas['EventIn'];

/** A refused event, kept with the reasons the server gave (`loc` still names its index in that batch). */
export type QuarantinedEvent = OutboxEvent & {
  errors: Schemas['ValidationErrorItem'][];
  quarantined_at: string;
};

// The runtime list `enqueue` checks against. `satisfies` ties it to the generated type: a type the
// server adds or drops fails the typecheck until it is mirrored here, and tests/outbox.test.ts
// compares the list (and its order) with openapi/openapi.json itself.
const EVENT_TYPE_SET = {
  habit_logged: true,
  habit_skipped: true,
  habit_vacation: true,
  day_closed: true,
  focus_started: true,
  focus_ended: true,
  breath_ended: true,
  mood_logged: true,
  confounder_tagged: true,
  app_opened: true,
} as const satisfies Record<EventType, true>;

/**
 * The closed set of event types the server accepts. The server rejects a whole batch with a 422 if
 * one event has any other type, so an unknown type is refused here, before it can reach the queue.
 */
export const EVENT_TYPES: readonly EventType[] = Object.freeze(Object.keys(EVENT_TYPE_SET) as EventType[]);

/** `flush` result. `offline` is true only when a request was attempted and the network failed or timed out. */
export interface FlushResult {
  sent: number;
  offline: boolean;
  /** Events the server refused by index during this flush and that were moved to quarantine. */
  quarantined: number;
}

/** What a flush had done before it was interrupted (see `flushedBefore`). */
export interface FlushProgress {
  sent: number;
  quarantined: number;
}

/** `enqueue` refused the event: an unknown type or a payload that is not a plain object. Nothing was stored. */
export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

/**
 * The server refused a batch and nothing in its answer says which event is at fault: any status
 * other than 200 or 422, or a 422 without an index inside the batch. The events stay queued, the
 * flush stops, and the next trigger tries again.
 */
export class BatchRejected extends Error {
  readonly status: number;
  /** The `errors` of a 422 answer, when it had any. */
  readonly errors: Schemas['ValidationErrorItem'][];

  constructor(status: number, errors: Schemas['ValidationErrorItem'][] = []) {
    super(`events rejected: HTTP ${status}`);
    this.name = 'BatchRejected';
    this.status = status;
    this.errors = errors;
  }
}

/**
 * The outbox database cannot be opened by this copy of the app; the shell should ask for a reload.
 * `version`: the stored database is newer than this code (a newer app version already ran here).
 * `blocked`: the upgrade waited more than `dbTimeouts.blockedGraceMs` for another tab to close.
 */
export class DatabaseNeedsReload extends Error {
  readonly reason: 'version' | 'blocked';

  constructor(reason: 'version' | 'blocked', options?: ErrorOptions) {
    super(`outbox database: reload needed (${reason})`, options);
    this.name = 'DatabaseNeedsReload';
    this.reason = reason;
  }
}

interface YawmiDB extends DBSchema {
  outbox: { key: string; value: OutboxEvent };
  quarantine: { key: string; value: QuarantinedEvent };
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

/** Open, upgrade and seed, mapping the two "this copy cannot open it" cases to `DatabaseNeedsReload`. */
function connect(): Promise<IDBPDatabase<YawmiDB>> {
  return new Promise<IDBPDatabase<YawmiDB>>((resolve, reject) => {
    let gaveUp = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    openDB<YawmiDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) db.createObjectStore(STORE, { keyPath: 'id' });
        if (oldVersion < 2) db.createObjectStore(QUARANTINE, { keyPath: 'id' });
      },
      blocked() {
        // Another tab still has the old version open. It usually closes on `versionchange` in a
        // moment; if not, stop waiting so the caller can ask for a reload.
        graceTimer ??= setTimeout(() => {
          gaveUp = true;
          reject(new DatabaseNeedsReload('blocked'));
        }, dbTimeouts.blockedGraceMs);
      },
      blocking() {
        // A newer version of the app wants to upgrade: step aside.
        closeDb();
      },
      terminated() {
        // The browser dropped the connection (Safari does this); open a new one next time.
        dbPromise = null;
      },
    }).then(
      async (db) => {
        clearTimeout(graceTimer);
        // The open completed after this call gave up on it: nobody holds the connection, so close it.
        if (gaveUp) {
          db.close();
          return;
        }
        try {
          await seedIdClock(db);
          resolve(db);
        } catch (error) {
          db.close();
          reject(error);
        }
      },
      (error: unknown) => {
        clearTimeout(graceTimer);
        const name = (error as { name?: unknown } | null)?.name;
        reject(name === 'VersionError' ? new DatabaseNeedsReload('version', { cause: error }) : error);
      },
    );
  });
}

/**
 * The shared connection, opened on first use. Rejects with `DatabaseNeedsReload` when this copy of
 * the app cannot open it (older than the stored database, or the upgrade is blocked by another tab).
 */
export function openDb(): Promise<IDBPDatabase<YawmiDB>> {
  dbPromise ??= connect().catch((error: unknown) => {
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

const isEventType = (type: unknown): type is EventType =>
  typeof type === 'string' && Object.hasOwn(EVENT_TYPE_SET, type);

/**
 * Queue an event. Resolves with its id once it is safely stored. Rejects with `InvalidEventError`,
 * storing nothing, if `type` is not one of `EVENT_TYPES` or `payload` is not a plain object.
 */
export async function enqueue(type: EventType, payload: EventPayload, occurredAt: Date = new Date()): Promise<string> {
  if (!isEventType(type)) throw new InvalidEventError(`unknown event type: ${JSON.stringify(type)}`);
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

/** How many events the server refused and that were set aside. They are kept, never sent again automatically. */
export async function quarantined(): Promise<number> {
  return (await openDb()).count(QUARANTINE);
}

/** The quarantined events, oldest first, each with the reasons the server gave. */
export async function listQuarantined(): Promise<QuarantinedEvent[]> {
  return (await openDb()).getAll(QUARANTINE);
}

/**
 * Put a quarantined event back in the queue under its own id, without the quarantine fields; the
 * next flush sends it. Reusing the id is safe: the server stored nothing from the refused batch.
 * Resolves false, changing nothing, when no quarantined event has that id.
 */
export async function requeue(id: string): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction([STORE, QUARANTINE], 'readwrite');
  const held = await tx.objectStore(QUARANTINE).get(id);
  if (held === undefined) {
    await tx.done;
    return false;
  }
  const { errors: _errors, quarantined_at: _at, ...event } = held;
  await tx.objectStore(STORE).put(event);
  await tx.objectStore(QUARANTINE).delete(id);
  await tx.done;
  return true;
}

function isErrorItem(value: unknown): value is Schemas['ValidationErrorItem'] {
  const item = value as { loc?: unknown; type?: unknown } | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    Array.isArray(item.loc) &&
    item.loc.every((part) => typeof part === 'string' || typeof part === 'number') &&
    typeof item.type === 'string'
  );
}

/** The `errors` of the server's 422 body (`ValidationErrorBody`), or none when it has another shape. */
async function readErrors(res: Response): Promise<Schemas['ValidationErrorItem'][]> {
  try {
    const body = (await res.json()) as { errors?: unknown } | null;
    return Array.isArray(body?.errors) ? body.errors.filter(isErrorItem) : [];
  } catch {
    return [];
  }
}

/** The batch index an error names (`loc` = `['body', 'events', i, ...]`), or null if it names none. */
function indexOf(error: Schemas['ValidationErrorItem'], size: number): number | null {
  const [where, field, index] = error.loc;
  if (where !== 'body' || field !== 'events' || typeof index !== 'number') return null;
  return Number.isInteger(index) && index >= 0 && index < size ? index : null;
}

type Step =
  | { kind: 'empty' }
  | { kind: 'offline' }
  | { kind: 'sent'; count: number }
  | { kind: 'quarantined'; count: number };

/** Move the events the server named to quarantine, in one transaction with their removal from the queue. */
async function quarantine(
  db: IDBPDatabase<YawmiDB>,
  events: OutboxEvent[],
  blamed: Map<number, Schemas['ValidationErrorItem'][]>,
): Promise<void> {
  const quarantined_at = new Date().toISOString();
  const tx = db.transaction([STORE, QUARANTINE], 'readwrite');
  for (const [index, errors] of blamed) {
    const event = events[index] as OutboxEvent;
    void tx.objectStore(QUARANTINE).put({ ...event, errors, quarantined_at });
    void tx.objectStore(STORE).delete(event.id);
  }
  await tx.done;
}

/** POST one batch. Null when the network failed or no answer came in time (the events stay queued). */
async function post(events: OutboxEvent[], send: SendFn): Promise<Response | null> {
  const body: Schemas['EventBatch'] = { events };
  try {
    return await send(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(flushTimeouts.requestMs),
    });
  } catch (error) {
    // Offline, the connection dropped, or no answer in time: not an error, everything stays queued
    // for the next trigger. (A timeout is a DOMException, not a TypeError.)
    if (error instanceof TypeError || isAbortOrTimeout(error)) return null;
    throw error;
  }
}

/**
 * A 422: quarantine only what the server pinned on an event of this batch. A refusal that names no
 * event (the batch shape, a proxy's own 422) keeps everything and stops: resending the same batch
 * would only be refused again.
 */
async function quarantineRefused(db: IDBPDatabase<YawmiDB>, events: OutboxEvent[], res: Response): Promise<Step> {
  const errors = await readErrors(res);
  const blamed = new Map<number, Schemas['ValidationErrorItem'][]>();
  for (const error of errors) {
    const index = indexOf(error, events.length);
    if (index !== null) blamed.set(index, [...(blamed.get(index) ?? []), error]);
  }
  if (blamed.size === 0) throw new BatchRejected(422, errors);
  await quarantine(db, events, blamed);
  return { kind: 'quarantined', count: blamed.size };
}

/** Send the oldest `size` events once. Every outcome but `empty` and `offline` removes at least one event. */
async function sendBatch(size: number, send: SendFn): Promise<Step> {
  const db = await openDb();
  const events = await db.getAll(STORE, null, size);
  if (events.length === 0) return { kind: 'empty' };

  const res = await post(events, send);
  if (res === null) return { kind: 'offline' };
  if (res.status === 422) return quarantineRefused(db, events, res);

  // Server contract (`post_events` in api/yawmi/routes/events.py): success is exactly HTTP 200
  // with `{accepted, duplicates}`. Anything else keeps the events. Deliberately strict: if the
  // route ever answers 201/202, change this together with the server, or the events would be
  // resent forever (harmless, since duplicates are ignored by id, but wasteful).
  if (res.status !== 200) throw new BatchRejected(res.status);
  // Delete only on an acknowledged answer that parses: a captive portal or proxy can answer 200
  // with something that is not the server's reply.
  let reply: unknown;
  try {
    reply = await res.json();
  } catch (error) {
    if (isAbortOrTimeout(error)) return { kind: 'offline' };
    throw error;
  }
  if (typeof reply !== 'object' || reply === null) throw new Error('events: unexpected response body');

  const tx = db.transaction(STORE, 'readwrite');
  for (const event of events) void tx.store.delete(event.id);
  await tx.done;
  return { kind: 'sent', count: events.length };
}

// What each interrupted flush had done, keyed by the error it rejected with.
const progressOf = new WeakMap<object, FlushProgress>();

/**
 * What a flush that rejected with `error` had already done: events sent (and deleted) and events
 * quarantined before the failure. Zeros for any other error.
 */
export function flushedBefore(error: unknown): FlushProgress {
  const known = typeof error === 'object' && error !== null ? progressOf.get(error) : undefined;
  return known ?? { sent: 0, quarantined: 0 };
}

/** Send batches until the queue is empty, the network is down, or a batch is refused (thrown). */
async function drain(batch: number, send: SendFn): Promise<FlushResult> {
  const size = Math.min(Math.max(Math.trunc(batch) || 1, 1), MAX_BATCH);
  let sent = 0;
  let quarantinedNow = 0;
  // Ends: every pass that goes round again removed at least one event from the queue.
  for (;;) {
    let step: Step;
    try {
      step = await sendBatch(size, send);
    } catch (error) {
      if (typeof error === 'object' && error !== null) progressOf.set(error, { sent, quarantined: quarantinedNow });
      throw error;
    }
    if (step.kind === 'empty') return { sent, offline: false, quarantined: quarantinedNow };
    if (step.kind === 'offline') return { sent, offline: true, quarantined: quarantinedNow };
    if (step.kind === 'sent') sent += step.count;
    else quarantinedNow += step.count;
  }
}

let inFlight: Promise<FlushResult> | null = null;

/**
 * Send every queued event, oldest first, in requests of up to `batch` events (at most 500). `batch`
 * sizes each request, it does not cap the flush: a large backlog goes out as back-to-back requests
 * in one flush, which ends at the first failure. Each batch is deleted once the server answers 200.
 * An event the server names in a 422 goes to quarantine and the rest are sent. Concurrent callers
 * in a tab share one run and its result; across tabs the run holds a Web Lock, so a second tab
 * waits (at most `flushTimeouts.lockWaitMs`, then resolves with nothing sent) and then finds only
 * what is left.
 *
 * Resolves with how many events were sent and quarantined, and `offline: true` when the network was
 * down or a request timed out. All zeros with `offline: false` means there was nothing to send (or
 * another tab kept the lock). Rejects, keeping the events not yet acknowledged, on `Unauthorized`,
 * `RefreshError`, `BatchRejected`, `DatabaseNeedsReload`, or a 200 that does not parse;
 * `flushedBefore(error)` then tells what had gone out before.
 */
export function flush(batch = 100, send: SendFn = authedFetch): Promise<FlushResult> {
  inFlight ??= withLock(FLUSH_LOCK, () => drain(batch, send), { waitMs: flushTimeouts.lockWaitMs })
    .catch((error: unknown): FlushResult => {
      if (error instanceof LockTimeout) return { sent: 0, offline: false, quarantined: 0 };
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
