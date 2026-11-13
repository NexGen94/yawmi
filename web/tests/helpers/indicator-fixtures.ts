// A server for the indicators and the settings, laid over whatever the page's other routes answer
// (`routeFetch` of the today fixtures, or `serve` of the goal-detail fixtures). It records every
// call, so a test can say how many times a route was asked and with what body.

import { vi } from 'vitest';

import type { components } from '../../src/api/schema';
import type { IndicatorIO } from '../../src/indicators/types';

export type SettingsOut = components['schemas']['SettingsOut'];

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export const SETTINGS: SettingsOut = {
  ai_checkin: 'evening',
  ai_lines: 2,
  ai_tone: 'direct',
  breath_prefs: null,
  breath_weekly_target_min: null,
  day_reminders: { morning: null, evening: null, weekly: null },
  digits: 'latn',
  focus_daily_target_min: null,
  goal_columns: { outcomes: [], milestones: [], cards: [] },
  late_notice_enabled: true,
  late_notice_time: '20:00',
  mission: '',
  vision: '',
};

export function indicator(over: Partial<IndicatorIO> = {}): IndicatorIO {
  return {
    subject_kind: 'habit',
    subject_ref: 'english',
    source: 'habit_logs',
    measure: 'total',
    period: 'week',
    display: 'number',
    id: '00000000-0000-4000-8000-000000000001',
    updated_at: '2026-11-10T08:00:00Z',
    ...over,
  };
}

export interface IndicatorServerOptions {
  indicators?: IndicatorIO[];
  settings?: Partial<SettingsOut>;
  /** A status for the answers of PUT, DELETE and PATCH other than success. */
  failWrites?: number;
  /** The habits a `PATCH /v1/habits/{code}` answers with (the patch laid over the one it names). */
  habits?: { code: string }[];
  /** The answer of `GET /v1/indicators` (a network failure, or a status). */
  failIndicators?: 'network' | number;
}

export interface IndicatorServer {
  calls: Call[];
  indicators: IndicatorIO[];
  settings: SettingsOut;
  called(method: string, path: RegExp | string): Call[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const isMine = (method: string, path: string): boolean =>
  path === '/v1/settings' || path.startsWith('/v1/indicators') || (method === 'PATCH' && /^\/v1\/habits\/[^/]+$/.test(path));

const sameSubject = (i: IndicatorIO, kind: string | undefined, ref: string | undefined): boolean =>
  i.subject_kind === kind && i.subject_ref === ref;

/** Answers a request that is one of ours; every call is already recorded. */
function answer(
  state: IndicatorServer,
  options: IndicatorServerOptions,
  method: string,
  path: string,
  body: unknown,
): Response {
  if (path === '/v1/indicators' && method === 'GET') {
    if (options.failIndicators === 'network') throw new TypeError('Failed to fetch');
    if (typeof options.failIndicators === 'number') return json({ detail: 'خطأ' }, options.failIndicators);
    return json({ items: state.indicators });
  }
  if (path === '/v1/settings') {
    if (method !== 'PATCH') return json(state.settings);
    if (options.failWrites) return json({ detail: 'خطأ' }, options.failWrites);
    state.settings = { ...state.settings, ...(body as Partial<SettingsOut>) };
    return json(state.settings);
  }
  if (options.failWrites && method !== 'GET') return json({ detail: 'خطأ' }, options.failWrites);
  const one = /^\/v1\/indicators\/([^/]+)\/([^/]+)$/.exec(path);
  if (one && method === 'PUT') {
    const saved = { ...(body as IndicatorIO), id: '00000000-0000-4000-8000-000000000002', updated_at: '2026-11-10T09:00:00Z' };
    state.indicators = [...state.indicators.filter((i) => !sameSubject(i, one[1], one[2])), saved];
    return json(saved);
  }
  if (one && method === 'DELETE') {
    state.indicators = state.indicators.filter((i) => !sameSubject(i, one[1], one[2]));
    return new Response(null, { status: 204 });
  }
  const habit = /^\/v1\/habits\/([^/]+)$/.exec(path);
  const found = habit ? options.habits?.find((h) => h.code === habit[1]) : undefined;
  if (habit && method === 'PATCH' && found) return json({ ...found, ...(body as object) });
  return json({ detail: 'not found' }, 404);
}

/** Lays the routes of the indicators and settings over the implementation `fetchMock` has now. */
export function withIndicators(fetchMock: ReturnType<typeof vi.fn>, options: IndicatorServerOptions = {}): IndicatorServer {
  const base = fetchMock.getMockImplementation() as Fetch | undefined;
  const state: IndicatorServer = {
    calls: [],
    indicators: [...(options.indicators ?? [])],
    settings: { ...SETTINGS, ...options.settings },
    called: (method, path) =>
      state.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path))),
  };
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input as Request;
    const method = request.method;
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (!isMine(method, path)) return base ? base(input, init) : json({ detail: 'not found' }, 404);
    const text = method === 'GET' ? '' : await request.clone().text();
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    state.calls.push({ method, path, body });
    return answer(state, options, method, path, body);
  });
  return state;
}
