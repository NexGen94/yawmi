// Authentication for the web client.
//
// The access token lives in module memory only: nothing sensitive reaches localStorage or
// IndexedDB. The long-lived refresh token is an HttpOnly cookie (`yawmi_rt`, Path=/v1/auth) that
// script cannot read; the browser attaches it to POST /v1/auth/refresh. The server rotates it on
// every refresh (a replayed token is refused), so two refreshes must never run at once with the
// same cookie. That is why a single in-flight refresh is shared by every request that sees a 401.

const REFRESH_URL = '/v1/auth/refresh';
const PAIR_URL = '/v1/devices/pair';
const PAIR_FAILED = 'تعذّر الإقران';

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
  // says nothing about whether the session is still valid.
  const res = await fetch(REFRESH_URL, {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(),
    body: '{}',
  });
  const token = res.ok ? await readAccessToken(res) : null;
  if (token === null) {
    clearAccessToken();
    throw new Unauthorized();
  }
  setAccessToken(token);
}

function refresh(): Promise<void> {
  refreshing ??= requestRefresh().finally(() => {
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
 */
export async function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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

/** Exchange a one-time pairing code for a session on this device (cookie plus in-memory token). */
export async function pair(code: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(PAIR_URL, {
      method: 'POST',
      credentials: 'include',
      headers: jsonHeaders(),
      body: JSON.stringify({ code, name: 'Safari iPhone', kind: 'web' }),
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
