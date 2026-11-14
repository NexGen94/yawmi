// @vitest-environment happy-dom
// Task 25, I-1: the seven days after each cycle are its review week, and the server counts them in
// the cycle (`day_in_cycle` is 59 on 2026-12-28). The home page, the goals cycle card and the habit
// grid say the same thing about them, from the cycle dates of the mirror.
import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider, Route, Router } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDigits } from '../../src/lib/format';
import GoalsPage from '../../src/pages/goals/index';
import HabitDetailPage from '../../src/pages/habits/detail';
import HomePage from '../../src/pages/home/index';
import { clearOutbox, closeDb } from '../../src/sync/outbox';
import { goals } from '../helpers/goals-fixtures';
import { habit, type HabitOut, type ProgressOut, routeFetch, STORY_HABITS, STORY_LOGS, todayOut } from '../helpers/today-fixtures';

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));
vi.mock('../../src/push/subscribe', () => ({ setBadge: vi.fn(async () => undefined) }));

const PROGRESS: ProgressOut = {
  adherence: 0.8,
  challenge: null,
  last_8_periods: [0.5],
  period_progress: { completion: 0.5, done: 20, expected: 40, need_per_day: 20, on_track: false, reached: false, target: 40 },
  streak: 1,
  strength: 0.5,
  total_done: 10,
};

let fetchMock: ReturnType<typeof vi.fn>;

/** The day 2026-12-28 (a Monday) at noon in Riyadh, the second day of the review week of cycle 1. */
const REVIEW_DAY = '2026-12-28';

function setDay(day: string): void {
  vi.setSystemTime(new Date(`${day}T09:00:00Z`));
}

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  setDay(REVIEW_DAY);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  setDigits('latn');
  await clearOutbox().catch(() => undefined);
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

/** What the server answers on `day`: its plan counts the review week in the cycle. */
function serve(day: string, cycle: number, dayInCycle: number, habits: HabitOut[] = STORY_HABITS): void {
  routeFetch(fetchMock, {
    habits,
    today: todayOut(habits, { day, plan: { cycle, day_in_cycle: dayInCycle, focus_outcomes: [] } }),
    logs: STORY_LOGS,
    goals: goals(),
    settings: {},
    progress: { english: PROGRESS },
  });
}

describe('home: the cycle line in the review week', () => {
  it('on 2026-12-28 says «أسبوع المراجعة · اليوم 2 من 7», not «اليوم 59 من 57»', async () => {
    serve(REVIEW_DAY, 1, 59);
    render(<HomePage />);
    expect(await screen.findByText('الدورة 1 · أسبوع المراجعة · اليوم 2 من 7')).toBeTruthy();
    expect(screen.queryByText(/59/)).toBeNull();
  });

  it('on day 57 says «الدورة 1 · اليوم 57 من 57»', async () => {
    setDay('2026-12-26');
    serve('2026-12-26', 1, 57);
    render(<HomePage />);
    expect(await screen.findByText('الدورة 1 · اليوم 57 من 57')).toBeTruthy();
  });

  it('on 2027-01-03 says «الدورة 2 · اليوم 1 من 84»', async () => {
    setDay('2027-01-03');
    serve('2027-01-03', 2, 1);
    render(<HomePage />);
    expect(await screen.findByText('الدورة 2 · اليوم 1 من 84')).toBeTruthy();
  });
});

describe('goals: the cycle card in the review week', () => {
  const open = async () => {
    history.replaceState(null, '', '/goals');
    serve(REVIEW_DAY, 1, 59);
    render(
      <LocationProvider>
        <GoalsPage />
      </LocationProvider>,
    );
    await screen.findByRole('radiogroup', { name: 'العرض' });
  };

  it('is still there on 2026-12-28, and says the review week and its day', async () => {
    await open();
    const card = await screen.findByRole('region', { name: 'الدورة 1' });
    expect(card.textContent).toContain('التأسيس');
    expect(card.textContent).toContain('أسبوع المراجعة');
    expect(card.textContent).toContain('اليوم 2 من 7');
    expect(card.textContent).not.toContain('59');
  });
});

describe('habit detail: the grid in the review week', () => {
  it('is the whole cycle that just ended (57 days), titled as the cycle', async () => {
    const english = habit('english', 'الإنجليزية', { start_day: '2026-11-01', outcome: 'O7' });
    serve(REVIEW_DAY, 1, 59, [english]);
    history.replaceState(null, '', '/habits/english');
    render(
      <LocationProvider>
        <Router>
          <Route path="/habits/:code" component={HabitDetailPage} />
          <Route default component={() => <p>غير موجود</p>} />
        </Router>
      </LocationProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'الإنجليزية' });
    const grid = await waitFor(() => screen.getByRole('img', { name: /أيام الدورة/ }));
    const cells = [...grid.querySelectorAll('g[data-state]')];
    expect(cells).toHaveLength(57);
    expect(cells[0]?.querySelector('title')?.textContent).toContain('31 أكتوبر');
    expect(cells[56]?.querySelector('title')?.textContent).toContain('26 ديسمبر');
    expect(screen.queryByRole('img', { name: /آخر 56 يوماً/ })).toBeNull();
  });
});
