// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider, Route, Router } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCache } from '../../src/data/cache';
import { todayQueryKey } from '../../src/habits/todayData';
import { setDigits } from '../../src/lib/format';
import HabitDetailPage from '../../src/pages/habits/detail';
import { clearOutbox, closeDb, listPending } from '../../src/sync/outbox';
import {
  DAY,
  habit,
  type HabitLogOut,
  type HabitOut,
  NOON_RIYADH,
  type ProgressOut,
  routeFetch,
  todayOut,
} from '../helpers/today-fixtures';

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

// 85 minutes since 2026-11-01, strength 0.756582, as in the design's examples (section 9).
const ENGLISH = habit('english', 'الإنجليزية', {
  anchor: 'free',
  kind: 'duration',
  unit: 'min',
  target_per_period: 45,
  start_day: '2026-11-01',
  outcome: 'O7',
  identity_text: 'أنا شخص يتقن الإنجليزية',
  reminders: [
    { time: '21:30', days_mask: 127 },
    { time: '07:15', days_mask: 0b0011111 },
  ],
});

const PROGRESS: ProgressOut = {
  adherence: 0.8,
  challenge: null,
  last_8_periods: [0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.5],
  period_progress: { completion: 0.55, done: 25, expected: 45, need_per_day: 20, on_track: false, reached: false, target: 45 },
  streak: 3,
  strength: 0.756582,
  total_done: 85,
};

const done = (day: string, value: number): HabitLogOut => ({ habit_code: 'english', day, status: 'done', value });
// Done on the 8th and 9th, skipped on the 7th, a vacation on the 6th, nothing on the 2nd to 5th (the
// habit started on the 1st, which has nothing either) and nothing today yet.
const LOGS: HabitLogOut[] = [
  done('2026-11-09', 45),
  done('2026-11-08', 60),
  { habit_code: 'english', day: '2026-11-07', status: 'skip', value: null },
  { habit_code: 'english', day: '2026-11-06', status: 'vacation', value: null },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setDigits('latn');
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

function serve(data: Parameters<typeof routeFetch>[1] = {}, options: Parameters<typeof routeFetch>[2] = {}): void {
  const habits: HabitOut[] = data.habits ?? [ENGLISH];
  routeFetch(
    fetchMock,
    { habits, today: todayOut(habits), logs: LOGS, progress: { english: PROGRESS }, ...data },
    options,
  );
}

/** The page from the real route: a LocationProvider and a Router that match `/habits/:code`. */
function mount(code = 'english') {
  history.replaceState(null, '', `/habits/${code}`);
  return render(
    <LocationProvider>
      <Router>
        <Route path="/habits/:code" component={HabitDetailPage} />
        <Route default component={() => <p>غير موجود</p>} />
      </Router>
    </LocationProvider>,
  );
}

async function open(data: Parameters<typeof routeFetch>[1] = {}, code = 'english') {
  serve(data);
  const view = mount(code);
  await screen.findByRole('heading', { level: 1, name: 'الإنجليزية' });
  await screen.findByRole('img', { name: /درجة القوة/ });
  return view;
}

describe('habit detail: the strength', () => {
  it('shows strength 0.756582 as 76, in a ring named «درجة القوة»', async () => {
    await open();
    const ring = screen.getByRole('img', { name: /درجة القوة/ });
    expect(ring.getAttribute('aria-label')).toBe('درجة القوة: 76%');
    expect(within(ring as unknown as HTMLElement).getByText('76%')).toBeTruthy();
  });

  it('says the score is not reset by a missed day: «لا تُصفَّر»', async () => {
    await open();
    expect(screen.getByText(/لا تُصفَّر/)).toBeTruthy();
  });

  it('writes the score in the digits setting', async () => {
    setDigits('arab');
    serve();
    mount();
    expect(await screen.findByText('٧٦٪')).toBeTruthy();
  });
});

describe('habit detail: the last eight periods', () => {
  it('draws eight bars, one per period, as a percentage of the target', async () => {
    await open();
    const bars = screen.getByRole('img', { name: /آخر 8 فترات/ });
    expect(bars.querySelectorAll('.bars-bar')).toHaveLength(8);
    expect(bars.getAttribute('aria-label')).toContain('الأحدث 50');
    expect(bars.getAttribute('aria-label')).toContain('الأعلى 90');
  });

  it('draws fewer when the habit is young (the server drops the periods before its start)', async () => {
    await open({ progress: { english: { ...PROGRESS, last_8_periods: [0.5, 1] } } });
    expect(screen.getByRole('img', { name: /آخر 8 فترات/ }).querySelectorAll('.bars-bar')).toHaveLength(2);
  });
});

describe('habit detail: the 56 days', () => {
  const grid = () => screen.getByRole('img', { name: /آخر 56 يوماً/ });

  it('draws 56 days, each with its symbol', async () => {
    await open();
    expect(grid().querySelectorAll('g[data-state]')).toHaveLength(56);
  });

  it('counts the four states in its name, and each one has a word in the key', async () => {
    await open();
    // done: the 8th and 9th. skipped: the 7th and the vacation of the 6th. missed: the 1st to 5th.
    // off: the 46 days before the start, and today, which has no log yet.
    const label = grid().getAttribute('aria-label') ?? '';
    expect(label).toContain('منجز 2');
    expect(label).toContain('متخطّى 2');
    expect(label).toContain('لم يُنجز 5');
    expect(label).toContain('غير مجدول 47');
    const key = grid().closest('.heatmap')?.querySelector('.heat-key') as HTMLElement;
    for (const word of ['منجز', 'لم يُنجز', 'متخطّى', 'غير مجدول']) expect(within(key).getByText(word)).toBeTruthy();
  });

  it('a slip is a missed day for an abstain habit, and a day without one is kept', async () => {
    const abstain = habit('no_sugar', 'ترك السكر', { polarity: 'abstain', start_day: '2026-11-01' });
    serve({
      habits: [abstain],
      logs: [{ habit_code: 'no_sugar', day: '2026-11-09', status: 'done', value: null }],
      progress: { no_sugar: PROGRESS },
    });
    mount('no_sugar');
    await screen.findByRole('heading', { level: 1, name: 'ترك السكر' });
    const label = (await screen.findByRole('img', { name: /آخر 56 يوماً/ })).getAttribute('aria-label') ?? '';
    // the 1st to the 8th and today are kept; the 9th is the slip
    expect(label).toContain('منجز 9');
    expect(label).toContain('لم يُنجز 1');
  });

  it('shows a log that is still in the outbox', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'تخطي اليوم' }));
    await waitFor(() => expect(grid().getAttribute('aria-label')).toContain('متخطّى 3'));
  });
});

describe('habit detail: the total', () => {
  it('writes 85 minutes since the start: «85 دقيقة منذ 2026-11-01»', async () => {
    await open();
    expect(screen.getByText('85 دقيقة منذ 2026-11-01')).toBeTruthy();
  });

  it('counts the days of a yes/no habit', async () => {
    const walk = habit('walk', 'المشي', { start_day: '2026-11-01' });
    serve({ habits: [walk], progress: { walk: { ...PROGRESS, total_done: 12 } }, logs: [] });
    mount('walk');
    expect(await screen.findByText('12 يوماً منذ 2026-11-01')).toBeTruthy();
  });

  it('counts times for a count habit without a unit', async () => {
    const pages = habit('pushups', 'ضغط', { kind: 'count', unit: '', target_per_period: 20, start_day: '2026-11-01' });
    serve({ habits: [pages], progress: { pushups: { ...PROGRESS, total_done: 40 } }, logs: [] });
    mount('pushups');
    expect(await screen.findByText('40 مرة منذ 2026-11-01')).toBeTruthy();
  });
});

describe('habit detail: the rest of the page', () => {
  it('shows the title, the identity sentence, the outcome and the anchor', async () => {
    await open();
    expect(screen.getByText('أنا شخص يتقن الإنجليزية')).toBeTruthy();
    expect(screen.getByText('O7')).toBeTruthy();
    expect(screen.getByText('خلال اليوم')).toBeTruthy();
  });

  it('lists the reminders with their days', async () => {
    await open();
    expect(screen.getByText('21:30 · كل يوم')).toBeTruthy();
    expect(screen.getByText('07:15 · الأحد، الاثنين، الثلاثاء، الأربعاء، الخميس')).toBeTruthy();
  });

  it('says so when there is no reminder', async () => {
    await open({ habits: [{ ...ENGLISH, reminders: [] }] });
    expect(screen.getByText('لا تذكيرات.')).toBeTruthy();
  });

  it('shows the streak, the adherence and the progress of the period', async () => {
    await open();
    expect(screen.getByText('3 أيام')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    // from the logs with the outbox over them, not from the server's copy: nothing is logged today
    expect(screen.getByText(/0 من 45 دقيقة اليوم/)).toBeTruthy();
  });

  it('draws the challenge when the habit has an end day', async () => {
    await open({
      progress: { english: { ...PROGRESS, challenge: { achieved: 12, total: 30, completion: 0.4, remaining_days: 18 } } },
    });
    expect(screen.getByText(/12 من 30 يوماً/)).toBeTruthy();
    expect(screen.getByText(/بقي 18 يوماً/)).toBeTruthy();
  });

  it('«تعديل» is the one prominent button and leads to the editor', async () => {
    await open();
    const link = screen.getByRole('link', { name: 'تعديل' });
    expect(link.getAttribute('href')).toBe('/habits/english/edit');
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(link.classList.contains('btn-primary')).toBe(true);
  });

  it('leaves no stand-in for the indicator card of a later task', async () => {
    await open();
    expect(screen.queryByText('إضافة تذكير')).toBeNull();
  });
});

describe('habit detail: skip and vacation', () => {
  it('«تخطي اليوم» queues one skip', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'تخطي اليوم' }));
    await waitFor(async () => expect(await listPending()).toHaveLength(1));
    const [event] = await listPending();
    expect(event?.type).toBe('habit_logged');
    expect(event?.payload).toMatchObject({ habit_code: 'english', status: 'skip' });
  });

  it('«إجازة» queues one vacation', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'إجازة' }));
    await waitFor(async () => expect(await listPending()).toHaveLength(1));
    const [event] = await listPending();
    expect(event?.payload).toMatchObject({ habit_code: 'english', status: 'vacation' });
  });

  it('says what was logged, and «تراجع» takes it back before the send', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'إجازة' }));
    await screen.findByText('سُجّلت إجازة اليوم: الإنجليزية');
    fireEvent.click(screen.getByRole('button', { name: 'تراجع' }));
    await waitFor(async () => expect(await listPending()).toHaveLength(0));
  });

  it('after the send «تراجع» says the log was sent', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'تخطي اليوم' }));
    await screen.findByText('سُجّل تخطّي اليوم: الإنجليزية');
    await clearOutbox();
    fireEvent.click(screen.getByRole('button', { name: 'تراجع' }));
    await screen.findByText('أُرسل التسجيل؛ التصحيح بتخطي اليوم');
  });

  it('an archived habit cannot be logged', async () => {
    await open({ habits: [{ ...ENGLISH, active: false }] });
    expect((screen.getByRole('button', { name: 'تخطي اليوم' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'إجازة' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('habit detail: the four states come from the route', () => {
  it('loading: skeletons, busy, and a heading already', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    mount();
    expect(document.querySelector('.state-frame')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(2);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('empty: a code that is not a habit says so and leads back to the list', async () => {
    serve();
    mount('nothing');
    await screen.findByText('لا توجد عادة بهذا الرمز.');
    expect(screen.getByRole('link', { name: 'العادات' }).getAttribute('href')).toBe('/habits');
  });

  it('error: «تعذّر التحميل» with a retry that reloads', async () => {
    serve({}, { fail: 500 });
    mount();
    await screen.findByText('تعذّر التحميل');
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByRole('img', { name: /درجة القوة/ });
  });

  it('offline with a saved copy: the copy and «نسخة محفوظة · بلا اتصال»', async () => {
    const first = await open();
    await waitFor(async () => expect(await readCache(todayQueryKey(DAY))).toBeDefined());
    await waitFor(async () => expect(await readCache(`habit-progress:english:${DAY}`)).toBeDefined());
    first.unmount();
    serve({}, { fail: 'network' });
    mount();
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    expect(screen.getByRole('img', { name: /درجة القوة/ })).toBeTruthy();
  });

  it('offline without a copy: «لا نسخة محفوظة بعد»', async () => {
    serve({}, { fail: 'network' });
    mount();
    await screen.findByText('لا نسخة محفوظة بعد');
  });
});
