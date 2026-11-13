// A server for the goal page: `GET /v1/goals`, the pace, the tasks, the edit log and the edits
// themselves, with the state a test can read back (`calls`, the stored edits). The habits and
// today's logs come from `routeFetch` of the today fixtures.

import { vi } from 'vitest';

import type { components } from '../../src/api/schema';
import {
  card,
  type GoalsOut,
  goals,
  milestone,
  type MilestoneFull,
  outcome,
} from './goals-fixtures';
import { DAY, habit, type HabitLogOut, type HabitOut, routeFetch, todayOut } from './today-fixtures';

type Schemas = components['schemas'];
export type PaceOut = Schemas['PaceOut'];
export type GoalTaskOut = Schemas['GoalTaskOut'];
export type GoalEditOut = Schemas['GoalEditOut'];

export const PUSHUPS = habit('pushups', 'تمارين الضغط', {
  kind: 'count',
  unit: '',
  period: 'day',
  target_per_period: 20,
  outcome: 'O1',
});
export const WALK = habit('walk_o1', 'المشي', { outcome: 'O1' });
export const HABITS: HabitOut[] = [PUSHUPS, WALK];
/** Two push-ups today. */
export const LOGS: HabitLogOut[] = [{ habit_code: 'pushups', day: DAY, status: 'done', value: 2 }];

/** The example of design 9.4. */
export const PACE: PaceOut = {
  basis: 'kpi',
  kpi_code: 'books_done',
  unit: 'كتاب',
  start_day: '2026-11-01',
  start_value: 0,
  due_day: '2026-12-31',
  target_value: 12,
  today: DAY,
  current_value: 2,
  expected_today: 3,
  projected_end: 8,
  on_pace: false,
  days_left: 45,
  readings: [
    { day: '2026-11-03', value: 1 },
    { day: DAY, value: 2 },
  ],
};

export function task(n: number, done: boolean): GoalTaskOut {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    goal_ref: 'O1',
    title: `مهمة ${n}`,
    due_day: null,
    done_at: done ? '2026-11-09T08:00:00Z' : null,
    position: n,
    archived: false,
  };
}
/** Five tasks, two of them done. */
export const TASKS: GoalTaskOut[] = [task(1, true), task(2, true), task(3, false), task(4, false), task(5, false)];

export function edit(id: number, over: Partial<GoalEditOut> = {}): GoalEditOut {
  return {
    id: `11111111-1111-4111-8111-11111111111${id}`,
    target_kind: 'milestone',
    page_id: 'm-late',
    field: 'due_date',
    old_value: '2026-11-08',
    new_value: '2026-11-14',
    note: '2026-11-10 · يومي: الموعد من «2026-11-08» إلى «2026-11-14»',
    status: 'pending',
    created_at: '2026-11-10T08:00:00Z',
    applied_at: null,
    error: null,
    ...over,
  };
}

const LATE = milestone('m-late', 'قياس خط الأساس', { outcome_code: 'O1', due_date: '2026-11-08', overdue_days: 2 });
const BLOOD = milestone('m-blood', 'فحص الدم السنوي', {
  outcome_code: 'O1',
  due_date: '2026-11-12',
  evidence: 'نتيجة المختبر',
  card_page_ids: ['c-health'],
});
const DONE = milestone('m-done-1', 'تعريف مؤشرات الصحة', { outcome_code: 'O1', due_date: '2026-11-02', done: true });

/** O1 with three milestones, two linked habits and a card with its own status. */
export function detailGoals(over: Partial<GoalsOut> = {}): GoalsOut {
  const base = goals();
  const mine = [DONE, LATE, BLOOD];
  return {
    ...base,
    milestones: [...mine, ...base.milestones.filter((m) => m.outcome_code !== 'O1')],
    outcomes: base.outcomes.map((o) =>
      o.code === 'O1'
        ? outcome('O1', {
            title: o.title,
            milestones_total: 3,
            milestones_done: 1,
            completion: 1 / 3,
            next_milestone: { page_id: 'm-late', title: LATE.title, due_date: '2026-11-08', cycle_no: 1 },
            habits: [
              { code: 'pushups', title_ar: 'تمارين الضغط', adherence: 0.5, total_done: 12 },
              { code: 'walk_o1', title_ar: 'المشي', adherence: 0.8, total_done: 1 },
            ],
            kpis: [
              { code: 'books_done', name: 'كتب', unit: 'كتاب', direction: 'up', target: 12, frequency: 'yearly', latest: null },
            ],
          })
        : o,
    ),
    cards: [
      card('c-health', 'خطة اللياقة', { outcome_codes: ['O1'], status: 'قيد التنفيذ', target_date: '2026-12-31', next_step: 'حجز موعد الفحص' }),
      card('c-english', 'مسار الإنجليزية', { outcome_codes: ['O7'], status: 'مخطط' }),
    ],
    ...over,
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export interface ServeOptions {
  goals?: GoalsOut;
  pace?: PaceOut | 404;
  tasks?: GoalTaskOut[];
  edits?: GoalEditOut[];
  /** The habits and logs of today. */
  habits?: HabitOut[];
  logs?: HabitLogOut[];
  fail?: 'network' | 500;
  /** A status for `PATCH` answers other than 200. */
  patchStatus?: number;
  patchBody?: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface Server {
  calls: Call[];
  /** What `GET /v1/goals/{ref}/pace` answers now (a test may change it between two requests). */
  pace: PaceOut | 404;
  goals: GoalsOut;
  edits: GoalEditOut[];
  tasks: GoalTaskOut[];
  called(method: string, path: RegExp | string): Call[];
}

/** Wires `fetchMock` to the goal page's routes. */
export function serve(fetchMock: ReturnType<typeof vi.fn>, options: ServeOptions = {}): Server {
  const state: Server = {
    calls: [],
    pace: options.pace ?? 404,
    goals: options.goals ?? detailGoals(),
    edits: [...(options.edits ?? [])],
    tasks: [...(options.tasks ?? TASKS)],
    called: (method, path) =>
      state.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path))),
  };
  const rest = vi.fn();
  routeFetch(rest, { habits: options.habits ?? HABITS, today: todayOut(options.habits ?? HABITS), logs: options.logs ?? LOGS }, {});
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input as Request;
    const url = new URL(request.url);
    const method = request.method;
    const path = decodeURIComponent(url.pathname);
    const text = method === 'GET' ? '' : await request.clone().text();
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    state.calls.push({ method, path, body });

    if (options.fail === 'network' && method === 'GET') throw new TypeError('Failed to fetch');
    if (options.fail === 500 && method === 'GET') return json({ detail: 'خطأ' }, 500);

    if (path === '/v1/goals' && method === 'GET') return json(state.goals);
    if (/^\/v1\/goals\/[^/]+\/pace$/.test(path)) {
      return state.pace === 404 ? json({ detail: 'لا مخرج' }, 404) : json(state.pace);
    }
    if (/^\/v1\/goals\/[^/]+\/tasks$/.test(path)) {
      if (method === 'GET') return json({ items: state.tasks });
      const added = { ...task(state.tasks.length + 1, false), title: (body as { title: string }).title };
      state.tasks.push(added);
      return json(added, 201);
    }
    if (path === '/v1/goal-edits') return json({ items: [...state.edits].reverse() });
    const cancel = /^\/v1\/goal-edits\/([^/]+)\/cancel$/.exec(path);
    if (cancel) {
      const row = state.edits.find((e) => e.id === cancel[1]);
      if (!row) return json({ detail: 'غير موجود' }, 404);
      row.status = 'cancelled';
      return json(row);
    }
    const milestonePatch = /^\/v1\/milestones\/([^/]+)$/.exec(path);
    if (milestonePatch && method === 'PATCH') {
      if (options.patchStatus && options.patchStatus !== 200) return json(options.patchBody ?? { detail: 'خطأ' }, options.patchStatus);
      const row = state.goals.milestones.find((m) => m.page_id === milestonePatch[1]) as MilestoneFull;
      const changes = body as Partial<MilestoneFull>;
      const next: MilestoneFull = { ...row, ...changes, pending: [...new Set([...row.pending, ...Object.keys(changes)])] };
      state.goals = { ...state.goals, milestones: state.goals.milestones.map((m) => (m.page_id === row.page_id ? next : m)) };
      if ('done' in changes) {
        // the summary of the outcome counts the shown milestones: one source for every number
        state.goals = {
          ...state.goals,
          outcomes: state.goals.outcomes.map((o) => {
            if (o.code !== row.outcome_code) return o;
            const done = o.milestones_done + (changes.done ? 1 : -1);
            return { ...o, milestones_done: done, completion: o.milestones_total === 0 ? null : done / o.milestones_total };
          }),
        };
      }
      for (const field of Object.keys(changes)) {
        state.edits.push(
          edit(state.edits.length + 1, { page_id: row.page_id, field, new_value: (changes as Record<string, string | boolean | null>)[field] ?? null }),
        );
      }
      return json(next);
    }
    const cardPatch = /^\/v1\/cards\/([^/]+)$/.exec(path);
    if (cardPatch && method === 'PATCH') {
      if (options.patchStatus && options.patchStatus !== 200) return json(options.patchBody ?? { detail: 'خطأ' }, options.patchStatus);
      const row = state.goals.cards.find((c) => c.page_id === cardPatch[1]);
      if (!row) return json({ detail: 'لا صفحة' }, 404);
      const next = { ...row, status: (body as { status: string }).status, pending: ['status'] };
      state.goals = { ...state.goals, cards: state.goals.cards.map((c) => (c.page_id === row.page_id ? next : c)) };
      return json(next);
    }
    return rest(input, init);
  });
  return state;
}
