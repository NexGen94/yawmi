// The story of design section 10 as API payloads: Tuesday 2026-11-10, six habits due, three done,
// the English habit at 25 of 45 minutes. Shared by the home page and `useHabitsToday` tests.

import type { components } from '../../src/api/schema';

type Schemas = components['schemas'];
export type HabitOut = Schemas['HabitOut'];
export type HabitDue = Schemas['HabitDue'];
export type HabitLogOut = Schemas['HabitLogOut'];
export type TodayOut = Schemas['TodayOut'];
export type JournalEntryOut = Schemas['JournalEntryOut'];
export type InsightOut = Schemas['InsightOut'];
export type ProgressOut = Schemas['ProgressOut'];

export const DAY = '2026-11-10';
export const NOON_RIYADH = '2026-11-10T09:00:00Z';

export function habit(code: string, title: string, over: Partial<HabitOut> = {}): HabitOut {
  return {
    ac_ref: null,
    active: true,
    anchor: 'free',
    anchor_day: null,
    code,
    created_by: 'seed',
    end_day: null,
    every_n: null,
    goal_ref: null,
    identity_text: null,
    kind: 'boolean',
    outcome: null,
    period: 'day',
    polarity: 'build',
    reminders: [],
    schedule_kind: 'every_day',
    start_day: '2026-10-31',
    system: false,
    target_per_period: 1,
    title_ar: title,
    unit: '',
    weekday_mask: null,
    ...over,
  };
}

/** The server's `HabitDue` row for a habit; the page recomputes progress from the logs. */
export function due(h: HabitOut): HabitDue {
  return {
    anchor: h.anchor,
    code: h.code,
    done_today: false,
    goal_ref: h.goal_ref,
    kind: h.kind,
    outcome: h.outcome,
    period: h.period,
    polarity: h.polarity,
    period_progress: { completion: 0, done: 0, expected: 0, need_per_day: 0, on_track: true, reached: false, target: h.target_per_period },
    status_today: null,
    target_per_period: h.target_per_period,
    title_ar: h.title_ar,
    unit: h.unit,
    value_today: null,
  };
}

export const WAKE_1 = habit('wake_water', 'شرب الماء', { anchor: 'after_wake', outcome: 'O1' });
export const WAKE_2 = habit('wake_plan', 'مراجعة الخطة', { anchor: 'after_wake' });
export const FREE_1 = habit('walk', 'المشي');
export const ENGLISH = habit('english', 'الإنجليزية', {
  anchor: 'free',
  kind: 'duration',
  unit: 'min',
  target_per_period: 45,
  outcome: 'O7',
});
export const READ = habit('read', 'القراءة', { anchor: 'free', kind: 'duration', unit: 'min', target_per_period: 20 });
export const SLEEP_1 = habit('sleep_screen', 'إطفاء الشاشات', { anchor: 'before_sleep' });

/** Six build habits due; wake_water, wake_plan and walk are done today, english is 25 of 45. */
export const STORY_HABITS: HabitOut[] = [WAKE_1, WAKE_2, FREE_1, ENGLISH, READ, SLEEP_1];

export const STORY_LOGS: HabitLogOut[] = [
  { habit_code: 'wake_water', day: DAY, status: 'done', value: null },
  { habit_code: 'wake_plan', day: DAY, status: 'done', value: null },
  { habit_code: 'walk', day: DAY, status: 'done', value: null },
  { habit_code: 'english', day: DAY, status: 'done', value: 25 },
  { habit_code: 'english', day: '2026-11-08', status: 'done', value: 60 },
];

export function todayOut(habits: HabitOut[] = STORY_HABITS, over: Partial<TodayOut> = {}): TodayOut {
  return {
    day: DAY,
    habits_due: habits.map(due),
    health: { recovery_7d: [], recovery_score: null, sleep_minutes: null, strain_score: null } as unknown as TodayOut['health'],
    insight: null,
    plan: { cycle: 1, day_in_cycle: 11, focus_outcomes: ['O1', 'O3', 'O7'] },
    ...over,
  };
}

/** The stored morning insight of `GET /v1/today` (since task 18 an `InsightOut`: cards and days). */
export function morningInsight(over: Partial<InsightOut> = {}): InsightOut {
  return {
    cards: [],
    created_at: '2026-11-10T03:00:00Z',
    day: DAY,
    days: [],
    id: '00000000-0000-7000-8000-000000000018',
    kind: 'morning',
    lines: [],
    priorities: [],
    question: null,
    source_ids: [],
    ...over,
  };
}

export function morningEntry(over: Record<string, unknown> = {}): JournalEntryOut {
  return {
    day: DAY,
    part: 'morning',
    logged_at: '2026-11-10T04:00:00Z',
    answers: { priorities: [], gratitude: [], enthusiasm: null, note: null, planned_minutes: null, ...over },
  };
}

export function eveningEntry(over: Record<string, unknown> = {}): JournalEntryOut {
  return {
    day: DAY,
    part: 'evening',
    logged_at: '2026-11-10T17:00:00Z',
    answers: { one_minute: true, priorities: [], gratitude: [], ...over },
  };
}

export interface ServerData {
  today?: TodayOut;
  habits?: HabitOut[];
  logs?: HabitLogOut[];
  journal?: JournalEntryOut[];
  reviews?: InsightOut[];
  /** `GET /v1/habits/{code}/progress`, by habit code; a habit without one answers 404. */
  progress?: Record<string, ProgressOut>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fetch router for the page's GETs. POST /v1/events never answers (the network is pending). */
export function routeFetch(
  fetchMock: ReturnType<typeof import('vitest').vi.fn>,
  data: ServerData = {},
  options: { fail?: 'network' | 500 } = {},
): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    if (request.method === 'POST') return new Promise<Response>(() => undefined);
    if (options.fail === 'network') throw new TypeError('Failed to fetch');
    if (options.fail === 500) return json({ detail: 'خطأ' }, 500);
    const progress = /^\/v1\/habits\/([^/]+)\/progress$/.exec(url.pathname);
    if (progress) {
      const body = data.progress?.[decodeURIComponent(progress[1] ?? '')];
      return body ? json(body) : json({ detail: 'not found' }, 404);
    }
    switch (url.pathname) {
      case '/v1/today':
        return json(data.today ?? todayOut(data.habits));
      case '/v1/habits':
        return json(data.habits ?? STORY_HABITS);
      case '/v1/habit-logs':
        return json({ logs: data.logs ?? STORY_LOGS });
      case '/v1/journal':
        return json({ entries: data.journal ?? [] });
      case '/v1/reviews':
        return json({ items: data.reviews ?? [] });
      default:
        return json({ detail: 'not found' }, 404);
    }
  });
}
