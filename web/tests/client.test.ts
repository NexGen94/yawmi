import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAccessToken, setAccessToken, Unauthorized } from '../src/api/auth';
import { API_BASE_URL, createApi } from '../src/api/client';

// The typed client is openapi-fetch over `authedFetch`, so it inherits the bearer token, the single
// shared refresh on a 401 and the one replay. These tests drive it through a mocked global fetch.

const OPENAPI = new URL('../../openapi/openapi.json', import.meta.url);
const spec = JSON.parse(readFileSync(OPENAPI, 'utf8')) as { paths: Record<string, unknown> };

// Node's Request needs an absolute URL; in the browser the default relative base is resolved
// against the page. Only the path is asserted.
const api = createApi({ baseUrl: 'https://yawmi.test' });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = readonly unknown[];
const requestOf = (call: Call | undefined): Request => call?.[0] as Request;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearAccessToken();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('typed API client', () => {
  it('keeps the base empty because every server path already starts with /v1/', () => {
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith('/v1/'), path).toBe(true);
    expect(API_BASE_URL).toBe('');
  });

  it('sends a typed request to the path as written, with the bearer token', async () => {
    setAccessToken('tok-1');
    fetchMock.mockResolvedValueOnce(json({ accepted: 0, duplicates: 0 }));

    const { data, error } = await api.POST('/v1/events', { body: { events: [] } });

    expect(error).toBeUndefined();
    expect(data).toEqual({ accepted: 0, duplicates: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = requestOf(fetchMock.mock.calls[0]);
    expect(new URL(request.url).pathname).toBe('/v1/events');
    expect(request.method).toBe('POST');
    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers ?? request.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('on a 401 refreshes once and replays the same request with the new token', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(json({ detail: 'غير مصرّح' }, 401))
      .mockResolvedValueOnce(json({ device_id: 'd', access_token: 'new', refresh_token: null }))
      .mockResolvedValueOnce(json({ accepted: 1, duplicates: 0 }));

    const body = {
      events: [
        {
          id: '01890a5d-ac96-774b-bcce-b302099a8057',
          type: 'app_opened' as const,
          payload: {},
          occurred_at: '2026-11-10T04:00:00.000Z',
          tz: 'Asia/Riyadh',
        },
      ],
    };
    const { data } = await api.POST('/v1/events', { body });

    expect(data).toEqual({ accepted: 1, duplicates: 0 });
    const urls = fetchMock.mock.calls.map((call: Call) => {
      const input = call[0];
      return input instanceof Request ? new URL(input.url).pathname : String(input);
    });
    expect(urls).toEqual(['/v1/events', '/v1/auth/refresh', '/v1/events']);
    const replay = requestOf(fetchMock.mock.calls[2]);
    const replayHeaders = new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.headers);
    expect(replayHeaders.get('Authorization')).toBe('Bearer new');
    expect(await replay.json()).toEqual(body);
  });

  it('surfaces a dead session as Unauthorized', async () => {
    setAccessToken('old');
    fetchMock.mockResolvedValueOnce(json({ detail: 'x' }, 401)).mockResolvedValueOnce(json({ detail: 'x' }, 401));

    await expect(api.GET('/v1/habits')).rejects.toBeInstanceOf(Unauthorized);
  });

  it('returns a typed error body for a non-2xx answer', async () => {
    setAccessToken('tok');
    fetchMock.mockResolvedValueOnce(json({ detail: 'طلب غير صالح', errors: [{ loc: ['body', 'title_ar'], type: 'missing' }] }, 422));

    const { data, error, response } = await api.POST('/v1/habits', {
      body: { title_ar: '', kind: 'boolean', target_per_period: 1, period: 'day', anchor: 'free', unit: '', schedule_kind: 'every_day', polarity: 'build' },
    });

    expect(data).toBeUndefined();
    expect(response.status).toBe(422);
    expect(error).toEqual({ detail: 'طلب غير صالح', errors: [{ loc: ['body', 'title_ar'], type: 'missing' }] });
  });
});
