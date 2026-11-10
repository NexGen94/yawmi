import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authedFetch,
  clearAccessToken,
  pair,
  PairError,
  RefreshError,
  refreshTimeouts,
  setAccessToken,
  Unauthorized,
} from '../src/api/auth';

// Node 24 ships navigator.locks in recent minors; where it is missing the fallback runs and the
// tests that need two real tabs sharing one lock are skipped (the engines floor stays >=24).
const hasWebLocks =
  typeof (globalThis.navigator as { locks?: { request?: unknown } } | undefined)?.locks?.request === 'function';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const UNAUTHORIZED = { detail: 'غير مصرّح' };
const TOKEN_PAIR = { device_id: 'd-1', access_token: 'new', refresh_token: null };

type Call = readonly unknown[];

const url = (call: Call | undefined): string => String(call?.[0]);
const initOf = (call: Call | undefined): RequestInit => (call?.[1] ?? {}) as RequestInit;
const authOf = (call: Call | undefined): string | null => new Headers(initOf(call).headers).get('Authorization');

let fetchMock: ReturnType<typeof vi.fn>;
const refreshCalls = (): Call[] => fetchMock.mock.calls.filter((call: Call) => url(call) === '/v1/auth/refresh');

beforeEach(() => {
  clearAccessToken();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authedFetch', () => {
  it('adds the bearer token and returns a non-401 response untouched', async () => {
    setAccessToken('tok-1');
    fetchMock.mockResolvedValueOnce(json({ ok: true }));

    const res = await authedFetch('/v1/things');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authOf(fetchMock.mock.calls[0])).toBe('Bearer tok-1');
  });

  it('sends no Authorization header while there is no token', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await authedFetch('/v1/things');
    expect(authOf(fetchMock.mock.calls[0])).toBeNull();
  });

  it('on 401 refreshes once with the cookie, then retries the request once', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(json(UNAUTHORIZED, 401))
      .mockResolvedValueOnce(json(TOKEN_PAIR))
      .mockResolvedValueOnce(json({ ok: true }));

    const res = await authedFetch('/v1/things', { method: 'POST', body: '{"a":1}' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refreshCalls()).toHaveLength(1);

    const refresh = refreshCalls()[0];
    expect(initOf(refresh)).toMatchObject({ method: 'POST', credentials: 'include', body: '{}' });
    expect(new Headers(initOf(refresh).headers).get('Content-Type')).toBe('application/json');

    const [first, , retry] = fetchMock.mock.calls as Call[];
    expect(authOf(first)).toBe('Bearer old');
    expect(authOf(retry)).toBe('Bearer new');
    expect(url(retry)).toBe('/v1/things');
    expect(initOf(retry).body).toBe('{"a":1}');
  });

  it('shares one refresh between two concurrent 401s', async () => {
    setAccessToken('old');
    let finishRefresh!: (res: Response) => void;
    const refreshGate = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      if (String(input) === '/v1/auth/refresh') return refreshGate;
      const bearer = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(bearer === 'Bearer new' ? json({ ok: true }) : json(UNAUTHORIZED, 401));
    });

    const a = authedFetch('/v1/a');
    const b = authedFetch('/v1/b');
    // Both first attempts come back 401 and queue on the one refresh, which is still pending.
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refreshCalls()).toHaveLength(1);

    finishRefresh(json(TOKEN_PAIR));
    const [ra, rb] = await Promise.all([a, b]);

    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(refreshCalls()).toHaveLength(1);
    // 2 first attempts + 1 refresh + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('does not refresh again for a 401 that was issued before the token was renewed', async () => {
    setAccessToken('old');
    let finishLate!: (res: Response) => void;
    const lateGate = new Promise<Response>((resolve) => {
      finishLate = resolve;
    });
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      const target = String(input);
      if (target === '/v1/auth/refresh') return Promise.resolve(json(TOKEN_PAIR));
      const bearer = new Headers(init?.headers).get('Authorization');
      if (bearer === 'Bearer new') return Promise.resolve(json({ ok: true }));
      return target === '/v1/slow' ? lateGate : Promise.resolve(json(UNAUTHORIZED, 401));
    });

    const fast = authedFetch('/v1/fast');
    const slow = authedFetch('/v1/slow');
    expect((await fast).status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);

    // The slow request's 401 arrives only after the refresh has finished.
    finishLate(json(UNAUTHORIZED, 401));
    expect((await slow).status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('throws Unauthorized when the retry is still 401, and drops the token', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(json(UNAUTHORIZED, 401))
      .mockResolvedValueOnce(json(TOKEN_PAIR))
      .mockResolvedValueOnce(json(UNAUTHORIZED, 401));

    await expect(authedFetch('/v1/things')).rejects.toBeInstanceOf(Unauthorized);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The dead token is gone: the next call goes out without one.
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await authedFetch('/v1/things');
    expect(authOf(fetchMock.mock.calls[3])).toBeNull();
  });

  it('throws Unauthorized, without retrying, when the refresh itself is refused', async () => {
    setAccessToken('old');
    fetchMock.mockResolvedValueOnce(json(UNAUTHORIZED, 401)).mockResolvedValueOnce(json(UNAUTHORIZED, 401));

    await expect(authedFetch('/v1/things')).rejects.toBeInstanceOf(Unauthorized);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('lets a network failure during refresh surface as a TypeError, and keeps the token', async () => {
    setAccessToken('old');
    fetchMock.mockResolvedValueOnce(json(UNAUTHORIZED, 401)).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const error = await authedFetch('/v1/things').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(Unauthorized);

    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await authedFetch('/v1/things');
    expect(authOf(fetchMock.mock.calls[2])).toBe('Bearer old');
  });

  it('treats a 403 from the refresh endpoint as a dead session, like 401', async () => {
    setAccessToken('old');
    fetchMock.mockResolvedValueOnce(json(UNAUTHORIZED, 401)).mockResolvedValueOnce(json({ detail: 'x' }, 403));

    await expect(authedFetch('/v1/things')).rejects.toBeInstanceOf(Unauthorized);

    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await authedFetch('/v1/things');
    expect(authOf(fetchMock.mock.calls[2])).toBeNull();
  });

  it.each([429, 500, 502, 503, 504])(
    'treats a %i from the refresh endpoint as a retryable failure: not Unauthorized, token kept',
    async (status) => {
      setAccessToken('old');
      fetchMock
        .mockResolvedValueOnce(json(UNAUTHORIZED, 401))
        .mockResolvedValueOnce(new Response('upstream down', { status }));

      const error = await authedFetch('/v1/things').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RefreshError);
      expect(error).not.toBeInstanceOf(Unauthorized);
      expect((error as RefreshError).status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The token survived, and the next 401 can refresh again.
      fetchMock
        .mockResolvedValueOnce(json({ ok: true }))
        .mockResolvedValueOnce(json(UNAUTHORIZED, 401))
        .mockResolvedValueOnce(json(TOKEN_PAIR))
        .mockResolvedValueOnce(json({ ok: true }));
      await authedFetch('/v1/things');
      expect(authOf(fetchMock.mock.calls[2])).toBe('Bearer old');

      const res = await authedFetch('/v1/things');
      expect(res.status).toBe(200);
      expect(refreshCalls()).toHaveLength(2);
    },
  );

  it('gives every caller sharing a failed refresh the retryable error, not Unauthorized', async () => {
    setAccessToken('old');
    let finishRefresh!: (res: Response) => void;
    const refreshGate = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    fetchMock.mockImplementation((input: unknown) =>
      Promise.resolve(String(input) === '/v1/auth/refresh' ? refreshGate : json(UNAUTHORIZED, 401)),
    );

    const a = authedFetch('/v1/a').catch((e: unknown) => e);
    const b = authedFetch('/v1/b').catch((e: unknown) => e);
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    finishRefresh(new Response('', { status: 503 }));

    expect(await a).toBeInstanceOf(RefreshError);
    expect(await b).toBeInstanceOf(RefreshError);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('treats a 200 refresh answer without an access token as a malformed reply, not a dead session', async () => {
    setAccessToken('old');
    fetchMock.mockResolvedValueOnce(json(UNAUTHORIZED, 401)).mockResolvedValueOnce(json({ device_id: 'd' }));

    const error = await authedFetch('/v1/things').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RefreshError);
    expect(error).not.toBeInstanceOf(Unauthorized);
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await authedFetch('/v1/things');
    expect(authOf(fetchMock.mock.calls[2])).toBe('Bearer old');
  });

  it('rejects a ReadableStream body up front, since it cannot be replayed after a refresh', async () => {
    setAccessToken('old');
    const body = new ReadableStream();

    await expect(authedFetch('/v1/upload', { method: 'POST', body, duplex: 'half' } as RequestInit)).rejects.toThrow(
      /ReadableStream/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still accepts every replayable body type', async () => {
    setAccessToken('old');
    fetchMock.mockImplementation(() => Promise.resolve(json({ ok: true })));
    for (const body of ['text', new Blob(['x']), new ArrayBuffer(2), new FormData(), new URLSearchParams('a=1')]) {
      await expect(authedFetch('/v1/upload', { method: 'POST', body })).resolves.toBeInstanceOf(Response);
    }
  });

  it('allows a new refresh after a failed one', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(json(UNAUTHORIZED, 401))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(UNAUTHORIZED, 401))
      .mockResolvedValueOnce(json(TOKEN_PAIR))
      .mockResolvedValueOnce(json({ ok: true }));

    await expect(authedFetch('/v1/things')).rejects.toBeInstanceOf(TypeError);
    const res = await authedFetch('/v1/things');
    expect(res.status).toBe(200);
    expect(refreshCalls()).toHaveLength(2);
  });

  it('replays the body of a Request input on retry', async () => {
    setAccessToken('old');
    const bodies: string[] = [];
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (!(input instanceof Request)) return json(TOKEN_PAIR);
      bodies.push(await input.text());
      const bearer = new Headers(init?.headers).get('Authorization');
      return bearer === 'Bearer new' ? json({ ok: true }) : json(UNAUTHORIZED, 401);
    });

    const res = await authedFetch(new Request('http://localhost/v1/things', { method: 'POST', body: '{"a":1}' }));

    expect(res.status).toBe(200);
    expect(bodies).toEqual(['{"a":1}', '{"a":1}']);
  });
});

describe('refresh across tabs', () => {
  it('holds the refresh lock while it rotates the cookie', async () => {
    const requested: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, ...rest: unknown[]) => {
          requested.push(name);
          return (rest.at(-1) as () => Promise<unknown>)();
        },
      },
    });
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(json(UNAUTHORIZED, 401))
      .mockResolvedValueOnce(json(TOKEN_PAIR))
      .mockResolvedValueOnce(json({ ok: true }));

    expect((await authedFetch('/v1/things')).status).toBe(200);
    expect(requested).toEqual(['yawmi-auth-refresh']);
  });

  it.skipIf(!hasWebLocks)('never sends two refreshes at once from two tabs: the second starts after the first has answered', async () => {
    // Two tabs: two module instances (each with its own in-memory token), one cookie jar (the
    // fetch mock) and Node's real navigator.locks shared between them.
    vi.resetModules();
    const tabA = await import('../src/api/auth');
    vi.resetModules();
    const tabB = await import('../src/api/auth');
    tabA.setAccessToken('a-old');
    tabB.setAccessToken('b-old');

    const gates: ((res: Response) => void)[] = [];
    let issued = 0;
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      if (String(input) === '/v1/auth/refresh') {
        return new Promise<Response>((resolve) => {
          gates.push(resolve);
        });
      }
      const bearer = new Headers(init?.headers).get('Authorization') ?? '';
      return Promise.resolve(bearer.startsWith('Bearer fresh-') ? json({ ok: true }) : json(UNAUTHORIZED, 401));
    });
    const answer = (): void => {
      issued += 1;
      gates.shift()?.(json({ ...TOKEN_PAIR, access_token: `fresh-${issued}` }));
    };

    const a = tabA.authedFetch('/v1/a');
    const b = tabB.authedFetch('/v1/b');
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshCalls()).toHaveLength(1);

    answer();
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(2));
    answer();

    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(refreshCalls()).toHaveLength(2);
  });

  it('still shares one in-tab refresh when the browser has no Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    setAccessToken('old');
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      if (String(input) === '/v1/auth/refresh') return Promise.resolve(json(TOKEN_PAIR));
      const bearer = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(bearer === 'Bearer new' ? json({ ok: true }) : json(UNAUTHORIZED, 401));
    });

    const [ra, rb] = await Promise.all([authedFetch('/v1/a'), authedFetch('/v1/b')]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(refreshCalls()).toHaveLength(1);
  });
});

describe('refresh timeouts', () => {
  const saved = { ...refreshTimeouts };
  afterEach(() => {
    Object.assign(refreshTimeouts, saved);
  });

  it('states the bounds: 15 s for the refresh request, 20 s waiting for another tab', () => {
    expect(saved).toEqual({ requestMs: 15_000, lockWaitMs: 20_000 });
  });

  it('gives up on a refresh that never answers with a retryable RefreshError, and keeps the token', async () => {
    refreshTimeouts.requestMs = 30;
    setAccessToken('old');
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      if (String(input) !== '/v1/auth/refresh') return Promise.resolve(json(UNAUTHORIZED, 401));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error), { once: true });
      });
    });

    const error = await authedFetch('/v1/things').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefreshError);

    // The token was kept: the next request still carries it.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await authedFetch('/v1/things');
    expect(authOf(fetchMock.mock.calls[0])).toBe('Bearer old');
  });

  it.skipIf(!hasWebLocks)(
    'a second tab stops waiting for a refresh holder that never answers, with RefreshError',
    async () => {
      vi.resetModules();
      const tabA = await import('../src/api/auth');
      vi.resetModules();
      const tabB = await import('../src/api/auth');
      tabA.setAccessToken('a-old');
      tabB.setAccessToken('b-old');
      tabB.refreshTimeouts.lockWaitMs = 40;
      let releaseA!: (res: Response) => void;
      fetchMock.mockImplementation((input: unknown) => {
        if (String(input) !== '/v1/auth/refresh') return Promise.resolve(json(UNAUTHORIZED, 401));
        // A frozen holder: ignores its abort signal and never answers until the test lets it.
        return new Promise<Response>((resolve) => {
          releaseA = resolve;
        });
      });

      const a = tabA.authedFetch('/v1/a').catch((e: unknown) => e);
      await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));

      const error = await tabB.authedFetch('/v1/b').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(tabB.RefreshError);
      expect(refreshCalls()).toHaveLength(1);

      releaseA(json(TOKEN_PAIR));
      await a;
    },
  );
});

describe('pair', () => {
  it('posts the code for a web device, stores the token and asks for persistent storage', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', { storage: { persist } });
    fetchMock
      .mockResolvedValueOnce(json({ device_id: 'd-1', access_token: 'paired', refresh_token: null }))
      .mockResolvedValueOnce(json({ ok: true }));

    await pair('ABCD2345');

    const first = fetchMock.mock.calls[0] as Call;
    expect(url(first)).toBe('/v1/devices/pair');
    expect(initOf(first)).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(initOf(first).body))).toEqual({
      code: 'ABCD2345',
      name: 'Safari iPhone',
      kind: 'web',
    });
    expect(persist).toHaveBeenCalledTimes(1);

    await authedFetch('/v1/things');
    expect(authOf(fetchMock.mock.calls[1])).toBe('Bearer paired');
  });

  it('still pairs when the browser has no storage persistence API', async () => {
    vi.stubGlobal('navigator', {});
    fetchMock.mockResolvedValueOnce(json({ device_id: 'd-1', access_token: 'paired', refresh_token: null }));
    await expect(pair('ABCD2345')).resolves.toBeUndefined();
  });

  it('still pairs when persist() rejects', async () => {
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockRejectedValue(new Error('denied')) } });
    fetchMock.mockResolvedValueOnce(json({ device_id: 'd-1', access_token: 'paired', refresh_token: null }));
    await expect(pair('ABCD2345')).resolves.toBeUndefined();
  });

  it('throws PairError carrying the server detail on a non-200', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'الكود غير صالح أو منتهٍ' }, 400));

    const error = await pair('WRONG').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PairError);
    expect((error as PairError).message).toBe('الكود غير صالح أو منتهٍ');
  });

  it('falls back to a generic Arabic message when the error has no usable detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(pair('X')).rejects.toMatchObject({ name: 'PairError', message: 'تعذّر الإقران' });

    fetchMock.mockResolvedValueOnce(json({ detail: [{ loc: ['body', 'code'], msg: 'bad' }] }, 422));
    await expect(pair('X')).rejects.toMatchObject({ name: 'PairError', message: 'تعذّر الإقران' });
  });

  it('reports a network failure as a PairError with the generic message', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(pair('X')).rejects.toMatchObject({ name: 'PairError', message: 'تعذّر الإقران' });
  });

  it('does not store a token when pairing fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'الكود غير صالح أو منتهٍ' }, 400));
    await pair('WRONG').catch(() => undefined);

    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await authedFetch('/v1/things');
    expect(authOf(fetchMock.mock.calls[1])).toBeNull();
  });
});
