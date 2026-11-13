import { vi } from 'vitest';

import type { components } from '../../src/api/schema';

// Shared by the AI screen tests (ask panel, consent, day close, settings): a fetch router that
// records every call with its decoded body, and builders of the replies the server gives.

type Schemas = components['schemas'];
export type GroundedInsight = Schemas['GroundedInsight'];
export type InsightOut = Schemas['InsightOut'];
export type SourceCard = Schemas['SourceCard'];
export type MemoryItem = Schemas['MemoryItem'];
export type ConsentOut = Schemas['ConsentOut'];
export type SettingsOut = Schemas['SettingsOut'];

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The server's coded error: `detail` plus one `errors` item that carries the code. */
export const coded = (status: number, detail: string, code: string): Response =>
  json({ detail, errors: [{ loc: ['body'], type: code }] }, status);

export const consentRequired = (): Response => coded(403, 'لا موافقة سارية على إرسال البيانات إلى مزوّد الذكاء الحالي', 'ai_consent_required');

export interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

export type Handler = (call: Call) => Response | Promise<Response>;

export interface Server {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: Call[];
  /** Calls of one route, e.g. `of('POST', '/v1/ask')`. */
  of(method: string, path: string): Call[];
}

/** Routes by `"METHOD /path"`. A route that is not listed answers 404. */
export function stubServer(routes: Record<string, Handler>): Server {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url, 'http://localhost');
    const text = request.method === 'GET' ? '' : await request.clone().text();
    const call: Call = { method: request.method, path: url.pathname, search: url.search, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const handler = routes[`${request.method} ${url.pathname}`];
    return handler ? handler(call) : json({ detail: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls, of: (method, path) => calls.filter((c) => c.method === method && c.path === path) };
}

export const DEFAULT_SETTINGS: SettingsOut = {
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

export const settings = (over: Partial<SettingsOut> = {}): SettingsOut => ({ ...DEFAULT_SETTINGS, ...over });

export function card(id: string, over: Partial<SourceCard> = {}): SourceCard {
  return {
    source_id: id,
    kind: id.split(':')[0] ?? 'habit',
    label: 'القراءة',
    value: 4,
    unit: 'من 7',
    text: 'القراءة: 4 من 7 هذا الأسبوع',
    trend: [1, 0, 1, 1, 0, 1, 0],
    day: null,
    ...over,
  };
}

export function grounded(over: Partial<GroundedInsight> = {}): GroundedInsight {
  return {
    lines: ['القراءة أعلى في أيام المشي.', 'المحطة O1 متأخرة يومين.'],
    question: null,
    source_ids: ['habit:read'],
    priorities: [],
    cards: [card('habit:read')],
    days: ['2026-11-09', '2026-11-10'],
    ...over,
  };
}

export function insightOut(over: Partial<InsightOut> = {}): InsightOut {
  return {
    ...grounded(),
    id: '00000000-0000-7000-8000-000000000020',
    kind: 'evening',
    day: '2026-11-10',
    created_at: '2026-11-10T17:00:00Z',
    ...over,
  };
}

export const consent = (over: Partial<ConsentOut> = {}): ConsentOut => ({
  provider: 'anthropic',
  granted: false,
  personal_text: false,
  granted_at: null,
  ...over,
});

export const memoryItem = (id: string, kind: 'rule' | 'note', text: string, active = true): MemoryItem => ({
  id,
  kind,
  text,
  active,
  created_at: '2026-11-10T10:00:00Z',
});
