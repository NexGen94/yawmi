// Authentication for the web client.
//
// The access token lives in module memory only: nothing sensitive reaches localStorage or
// IndexedDB. The long-lived refresh token is an HttpOnly cookie (`yawmi_rt`, Path=/v1/auth) that
// script cannot read; the browser attaches it to POST /v1/auth/refresh. The server rotates it on
// every refresh (a replayed token is refused), so two refreshes must never run at once with the
// same cookie. That is why a single in-flight refresh is shared by every request that sees a 401,
// and why the refresh also holds a Web Lock: other tabs share the cookie jar (each keeps its own
// in-memory token), so a refresh in one tab waits until another tab's rotation has landed.

import { LockTimeout, withLock } from '../lib/locks';
import { isAbortOrTimeout } from '../lib/timeout';
import type { components } from './schema';

const REFRESH_URL = '/v1/auth/refresh';
const PAIR_URL = '/v1/devices/pair';
const PAIR_FAILED = 'تعذّر الإقران';
/** Cross-tab lock name for the cookie rotation. */
const REFRESH_LOCK = 'yawmi-auth-refresh';

/**
 * Bounds on the refresh, in milliseconds. The request is bounded because it runs under the
 * cross-tab lock; the wait is longer than one request, so a tab only gives up on a holder that is
 * stuck (suspended or frozen), not on one that is merely slow. Mutable for tests only.
 */
export const refreshTimeouts = { requestMs: 15_000, lockWaitMs: 20_000 };

let accessToken: string | null = null;
let refreshing: Promise<void> | null = null;

export function setAccessToken(token: string): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}

/** The session cannot be recovered (no valid refresh cookie). The app should show the pairing screen. */
export class Unauthorized extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'Unauthorized';
  }
}

/**
 * The refresh could not be completed for a reason that says nothing about the session: a 5xx or
 * 429 from the server or its proxy, a reply that is not a token, no answer within
 * `refreshTimeouts.requestMs`, or another tab holding the refresh longer than
 * `refreshTimeouts.lockWaitMs`. The token is kept and the caller may simply try again later.
 * (A network failure is not wrapped: it stays a `TypeError`.)
 */
export class RefreshError extends Error {
  /** The HTTP status, or `undefined` for a malformed 200. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RefreshError';
    this.status = status;
  }
}

/** Pairing failed. `message` is Arabic and safe to show to the user. */
export class PairError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PairError';
  }
}

const jsonHeaders = (): Headers => new Headers({ 'Content-Type': 'application/json' });

async function readAccessToken(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const token = (body as { access_token?: unknown } | null)?.access_token;
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    return null;
  }
}

async function requestRefresh(): Promise<void> {
  // A network failure (TypeError) is deliberately not turned into Unauthorized: being offline
  // says nothing about whether the session is still valid. The same goes for a 5xx or 429.
  let res: Response;
  try {
    res = await fetch(REFRESH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: jsonHeaders(),
      body: '{}',
      signal: AbortSignal.timeout(refreshTimeouts.requestMs),
    });
  } catch (error) {
    if (isAbortOrTimeout(error)) throw new RefreshError('refresh: no answer in time');
    throw error;
  }
  // Only a refusal by the server means the cookie is dead (invalid, rotated away, or the device
  // was revoked); then drop the token and let the app show the pairing screen.
  if (res.status === 401 || res.status === 403) {
    clearAccessToken();
    throw new Unauthorized();
  }
  if (!res.ok) throw new RefreshError(`refresh failed: HTTP ${res.status}`, res.status);
  const token = await readAccessToken(res);
  if (token === null) throw new RefreshError('refresh: the reply carries no access token');
  setAccessToken(token);
}

function refresh(): Promise<void> {
  refreshing ??= withLock(REFRESH_LOCK, requestRefresh, { waitMs: refreshTimeouts.lockWaitMs })
    .catch((error: unknown) => {
      if (error instanceof LockTimeout) throw new RefreshError('refresh: another tab is still refreshing');
      throw error;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function send(input: RequestInfo | URL, init: RequestInit | undefined, token: string | null): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (token === null) headers.delete('Authorization');
  else headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/**
 * `fetch` with the bearer token. On a 401 it refreshes the token once (shared by concurrent
 * callers), replays the request once, and throws `Unauthorized` if the session is still refused.
 * If the refresh fails for a reason that does not condemn the session it throws a `RefreshError`
 * (or the network `TypeError`) and keeps the token.
 *
 * Because the request may be sent twice, `init.body` must be replayable: a string, `Blob`,
 * `ArrayBuffer`, `FormData` or `URLSearchParams`. A `ReadableStream` is consumed by the first
 * send, so it is rejected up front. A `Request` input is cloned, so its own body is fine.
 */
export async function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream) {
    throw new Error('authedFetch: a ReadableStream body cannot be replayed after a token refresh');
  }
  // A Request body can be read only once, so keep an unread copy for the replay.
  const replay = input instanceof Request ? input.clone() : input;
  const usedToken = accessToken;

  const first = await send(input, init, usedToken);
  if (first.status !== 401) return first;

  // If the token was already renewed while this request was in flight, its 401 is stale: replay
  // with the new token instead of rotating the refresh cookie again.
  if (accessToken === null || accessToken === usedToken) await refresh();

  const second = await send(replay, init, accessToken);
  if (second.status === 401) {
    clearAccessToken();
    throw new Unauthorized();
  }
  return second;
}

function pairErrorMessage(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  return typeof detail === 'string' && detail !== '' ? detail : PAIR_FAILED;
}

/** How this device is listed among the paired devices: a device name, addressed to no one. */
const DEVICE_NAME = 'Safari iPhone';

/** Exchange a one-time pairing code for a session on this device (cookie plus in-memory token). */
export async function pair(code: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(PAIR_URL, {
      method: 'POST',
      credentials: 'include',
      headers: jsonHeaders(),
      body: JSON.stringify({ code, name: DEVICE_NAME, kind: 'web' } satisfies components['schemas']['PairRequest']),
    });
  } catch (cause) {
    throw new PairError(PAIR_FAILED, { cause });
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new PairError(pairErrorMessage(body));
  }
  const token = await readAccessToken(res);
  if (token === null) throw new PairError(PAIR_FAILED);
  setAccessToken(token);

  // Ask the browser not to evict this site's storage (the outbox lives in IndexedDB). Not awaited:
  // some browsers prompt, and pairing must not wait on that. A refusal or a missing API is fine.
  try {
    void navigator.storage?.persist?.()?.catch(() => undefined);
  } catch {
    // no storage API in this environment
  }
}
