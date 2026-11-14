import { fireEvent, render, screen } from '@testing-library/preact';
import { LocationProvider, Route, Router } from 'preact-iso';
import { vi } from 'vitest';

import type { components } from '../../src/api/schema';
import { todayRiyadh } from '../../src/lib/today';
import DayPage from '../../src/pages/day/index';
import { listPending } from '../../src/sync/outbox';

// Shared by the day page tests. Each test file keeps its own vi.mock of the outbox.

export type TodayOut = components['schemas']['TodayOut'];
export type HabitDue = components['schemas']['HabitDue'];
export type JournalEntryOut = components['schemas']['JournalEntryOut'];
export type MoodLogOut = components['schemas']['MoodLogOut'];

// 12:00 in Riyadh on 2026-11-10: the morning side of the 15:00 switch.
export const NOW = '2026-11-10T09:00:00Z';
export const DAY = '2026-11-10';
export const WEEK_AGO = '2026-11-03';
export const MONTH_AGO = '2026-10-11';

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function habit(code: string, title: string, over: Partial<HabitDue> = {}): HabitDue {
  return {
    anchor: 'free',
    code,
    polarity: 'build',
    done_today: false,
    goal_ref: null,
    kind: 'boolean',
    outcome: null,
    period: 'day',
    period_progress: { completion: 0, done: 0, expected: 1, need_per_day: 1, on_track: true, reached: false, target: 1 },
    status_today: null,
    target_per_period: 1,
    title_ar: title,
    unit: '',
    value_today: null,
    ...over,
  } as HabitDue;
}

export function todayOut(over: Partial<TodayOut> = {}): TodayOut {
  return {
    day: todayRiyadh(),
    habits_due: [],
    health: { data_quality: 'missing', recovery_7d: [], recovery_score: null, sleep_minutes: null, strain_score: null },
    insight: null,
    plan: { cycle: 2, day_in_cycle: 11, focus_outcomes: ['O4', 'O5'] },
    ...over,
  };
}

export const entry = (day: string, part: 'morning' | 'evening', answers: Record<string, unknown>): JournalEntryOut => ({
  day,
  part,
  answers,
  logged_at: `${day}T10:00:00Z`,
});

export interface Api {
  today: () => Response | Promise<Response>;
  journal: () => Response | Promise<Response>;
  mood: () => Response | Promise<Response>;
}

export type MemoryItem = components['schemas']['MemoryItem'];

/** A memory item as `GET /v1/ai/memory` lists it. */
export const memoryItem = (kind: 'rule' | 'note', text: string, active = true, id = '00000000-0000-7000-8000-000000000001'): MemoryItem => ({
  active,
  created_at: '2026-11-01T08:00:00Z',
  id,
  kind,
  text,
});

/** The settings of the person as `GET /v1/settings` answers, the keys given over the defaults. */
export const settingsBody = (over: Record<string, unknown> = {}) => ({
  ai_checkin: 'evening',
  ai_lines: 2,
  ai_tone: 'direct',
  digits: 'latn',
  late_notice_enabled: false,
  late_notice_time: '20:00',
  mission: '',
  vision: '',
  ...over,
});

/** Answers GET /v1/today, /v1/journal and /v1/mood from the given bodies; a handler may throw. */
export function stubApi(
  data: {
    today?: TodayOut;
    journal?: JournalEntryOut[];
    mood?: MoodLogOut[];
    /** `GET /v1/settings`, `GET /v1/ai/memory` and `GET /v1/goals`: unread (404) unless given. */
    settings?: Record<string, unknown>;
    memory?: MemoryItem[];
    goals?: unknown;
  } = {},
  over: Partial<Api> = {},
) {
  const handlers: Api = {
    today: () => json(data.today ?? todayOut()),
    journal: () => json({ entries: data.journal ?? [] }),
    mood: () => json({ logs: data.mood ?? [] }),
    ...over,
  };
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    calls.push(url);
    if (url.pathname === '/v1/today') return handlers.today();
    if (url.pathname === '/v1/journal') return handlers.journal();
    if (url.pathname === '/v1/mood') return handlers.mood();
    if (url.pathname === '/v1/settings' && data.settings) return json(data.settings);
    if (url.pathname === '/v1/ai/memory' && data.memory) return json({ items: data.memory, attached: { mission: false, vision: false } });
    if (url.pathname === '/v1/goals' && data.goals) return json(data.goals);
    return json({ detail: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

export const offline = (): never => {
  throw new TypeError('Failed to fetch');
};

export function RoutedDay() {
  return (
    <LocationProvider>
      <Router>
        <Route path="/day" component={DayPage} />
        <Route path="/day/morning" component={DayPage} />
        <Route path="/day/evening" component={DayPage} />
      </Router>
    </LocationProvider>
  );
}

export const go = (path: string): void => history.replaceState(null, '', path);

export async function openDay(path: '/day/morning' | '/day/evening') {
  go(path);
  const view = render(<RoutedDay />);
  await screen.findByRole('heading', { level: 1, name: 'اليوم' });
  return view;
}

export const type = (label: string | RegExp, value: string): void => {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
};

export const click = (name: string | RegExp, role = 'button'): void => {
  fireEvent.click(screen.getByRole(role, { name }));
};

export async function pendingOf(type: string) {
  return (await listPending()).filter((e) => e.type === type);
}


export const evening = {
  habits: [
    habit('h_read', 'القراءة', { done_today: true, status_today: 'done' }),
    habit('h_walk', 'المشي', { done_today: true, status_today: 'done' }),
    habit('h_water', 'الماء'),
    habit('h_sugar', 'بلا سكر', { done_today: true, status_today: 'done', polarity: 'abstain' }),
  ],
  morning: entry(DAY, 'morning', {
    priorities: [
      { title: 'مراجعة الفصل', source_id: null, goal_ref: null },
      { title: 'تمرين المشي', source_id: null, goal_ref: null },
    ],
    planned_minutes: 90,
  }),
};

export function stubEvening(over: { journal?: JournalEntryOut[]; mood?: MoodLogOut[] } = {}) {
  return stubApi(
    { journal: over.journal ?? [evening.morning], mood: over.mood },
    // built at request time, so a test that moves the clock gets the new day from the server too
    { today: () => json(todayOut({ habits_due: evening.habits })) },
  );
}

