import { openDb } from '../sync/outbox';

const CACHE_STORE = 'cache';
const KV_STORE = 'kv';

export interface CacheRecord<T = unknown> {
  value: T;
  savedAt: string;
}

/**
 * Read the last cached response for `key`.
 * Returns `{ value, savedAt }` or `undefined` if none is stored.
 */
export async function readCache<T>(key: string): Promise<{ value: T; savedAt: string } | undefined> {
  const db = await openDb();
  const entry = (await db.get(CACHE_STORE, key)) as CacheRecord<T> | undefined;
  if (!entry) return undefined;
  return { value: entry.value, savedAt: entry.savedAt };
}

/**
 * Store a response in IndexedDB `cache` with an ISO timestamp (`savedAt`).
 */
export async function writeCache(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const savedAt = new Date().toISOString();
  await db.put(CACHE_STORE, { value, savedAt }, key);
}

/**
 * Clear all cached records from the `cache` store.
 */
export async function clearCache(): Promise<void> {
  const db = await openDb();
  await db.clear(CACHE_STORE);
}

/**
 * Read a value by key from the `kv` store.
 */
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const value = await db.get(KV_STORE, key);
  return value as T | undefined;
}

/**
 * Set a key-value pair in the `kv` store.
 */
export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await db.put(KV_STORE, value, key);
}

/**
 * Delete a key from the `kv` store.
 */
export async function kvDelete(key: string): Promise<void> {
  const db = await openDb();
  await db.delete(KV_STORE, key);
}

/**
 * Clear all keys from the `kv` store.
 */
export async function clearKv(): Promise<void> {
  const db = await openDb();
  await db.clear(KV_STORE);
}
