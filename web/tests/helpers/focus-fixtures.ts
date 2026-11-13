// The focus API as test data, and a fetch router that serves it beside the habits of the story
// (today-fixtures). Plans can be created and patched, so a reload after a write shows them.

import { vi } from 'vitest';

import type { components } from '../../src/api/schema';
import { goals } from './goals-fixtures';
import { routeFetch, type ServerData } from './today-fixtures';

type Schemas = components['schemas'];
export type FocusPlanOut = Schemas['FocusPlanOut'];
export type FocusSessionOut = Schemas['FocusSessionOut'];

export const PLAN_ID = '00000000-0000-7000-8000-0000000000a1';
export const PLAN_ID_2 = '00000000-0000-7000-8000-0000000000a2';

export function plan(over: Partial<FocusPlanOut> = {}): FocusPlanOut {
  return {
    id: PLAN_ID,
    title_ar: 'عمل عميق',
    minutes: 90,
    goal_ref: null,
    habit_code: null,
    favorite: false,
    weekday_mask: null,
    start_time: null,
    active: true,
    updated_at: '2026-11-09T08:00:00Z',
    ...over,
  };
}

export function sessionOut(startedAt: string, endedAt: string | null, over: Partial<FocusSessionOut> = {}): FocusSessionOut {
  return {
    id: '00000000-0000-7000-8000-0000000000b1',
    day: '2026-11-10',
    started_at: startedAt,
    ended_at: endedAt,
    planned_minutes: 25,
    actual_minutes: 25,
    goal_ref: null,
    habit_code: null,
    focus_rating: null,
    next_step: null,
    ...over,
  };
}

export interface FocusServer extends ServerData {
  plans?: FocusPlanOut[];
  sessions?: FocusSessionOut[];
  /** `GET /v1/goals`; without it the goals are unread (404). */
  withGoals?: boolean;
}

export interface FocusRequests {
  posts: { url: string; body: unknown }[];
  patches: { url: string; body: unknown }[];
  /** The URLs of the GETs, for a test that asks what was read. */
  gets: string[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Routes the page's requests. `POST /v1/events` never answers (the network is pending). */
export function routeFocus(
  fetchMock: ReturnType<typeof vi.fn>,
  data: FocusServer = {},
  options: { fail?: 'network' | 500 } = {},
): FocusRequests {
  const requests: FocusRequests = { posts: [], patches: [], gets: [] };
  const plans = [...(data.plans ?? [])];
  // The habit story and the other reads come from the shared router, on a mock of their own.
  const shared = vi.fn();
  routeFetch(shared, data, options.fail ? { fail: options.fail } : {});

  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    if (url.pathname === '/v1/events') return new Promise<Response>(() => undefined);
    if (options.fail === 'network') throw new TypeError('Failed to fetch');
    if (options.fail === 500) return json({ detail: 'خطأ' }, 500);
    if (url.pathname === '/v1/focus/plans') {
      if (request.method === 'POST') {
        const body = (await request.clone().json()) as Record<string, unknown>;
        requests.posts.push({ url: url.pathname, body });
        const created = plan({
          id: `00000000-0000-7000-8000-0000000001${String(plans.length).padStart(2, '0')}`,
          title_ar: String(body.title_ar),
          minutes: Number(body.minutes),
          favorite: body.favorite === true,
          goal_ref: (body.goal_ref as string | null | undefined) ?? null,
          habit_code: (body.habit_code as string | null | undefined) ?? null,
          weekday_mask: (body.weekday_mask as number | null | undefined) ?? null,
          start_time: (body.start_time as string | null | undefined) ?? null,
        });
        plans.push(created);
        return json(created, 201);
      }
      requests.gets.push(url.pathname + url.search);
      return json({ items: url.searchParams.get('all') === 'true' ? plans : plans.filter((p) => p.active) });
    }
    const patch = /^\/v1\/focus\/plans\/([^/]+)$/.exec(url.pathname);
    if (patch && request.method === 'PATCH') {
      const body = (await request.clone().json()) as Partial<FocusPlanOut>;
      requests.patches.push({ url: url.pathname, body });
      const found = plans.find((p) => p.id === patch[1]);
      if (!found) return json({ detail: 'not found' }, 404);
      Object.assign(found, body);
      return json(found);
    }
    if (url.pathname === '/v1/focus/sessions') {
      requests.gets.push(url.pathname + url.search);
      return json({ items: data.sessions ?? [] });
    }
    if (url.pathname === '/v1/goals' && data.withGoals) return json(goals());
    return shared(request) as Promise<Response>;
  });
  return requests;
}
