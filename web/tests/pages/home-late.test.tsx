// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromOrdinal, toOrdinal } from '../../src/domain/days';
import { MissionCard } from '../../src/pages/home/MissionCard';
import HomePage from '../../src/pages/home/index';
import { setDigits } from '../../src/lib/format';
import { clearOutbox, closeDb, listPending } from '../../src/sync/outbox';
import { type GoalsOut, goals as plan, milestone, outcome } from '../helpers/goals-fixtures';
import { SETTINGS, withIndicators } from '../helpers/indicator-fixtures';
import { DAY, habit, type HabitLogOut, type HabitOut, NOON_RIYADH, routeFetch, todayOut } from '../helpers/today-fixtures';

const mocks = vi.hoisted(() => ({ setBadge: vi.fn(async (_n: number) => undefined) }));

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));
vi.mock('../../src/push/subscribe', () => ({ setBadge: mocks.setBadge }));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  setDigits('latn');
  vi.restoreAllMocks();
  await clearOutbox().catch(() => undefined);
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const logRow = (code: string, day: string, status: HabitLogOut['status'] = 'done', value: number | null = null): HabitLogOut => ({
  habit_code: code,
  day,
  status,
  value,
});

const thirty = (code: string, first: string, skip: string): HabitLogOut[] =>
  Array.from({ length: 30 }, (_, i) => fromOrdinal(toOrdinal(first) + i))
    .filter((day) => day !== skip)
    .map((day) => logRow(code, day));

/** A daily habit missed yesterday: its strength sentence is the one of design 9.2. */
const DAILY = habit('daily', 'تمرين', { start_day: '2026-10-10' });
/** A weekly habit of 285 minutes at 85: S3. */
const WEEKLY = habit('weekly', 'الإنجليزية', { kind: 'duration', unit: 'min', period: 'week', target_per_period: 285, start_day: '2026-11-01' });
const QUIT = habit('quit', 'الامتناع', { polarity: 'abstain', start_day: '2026-11-01' });

interface Setup {
  habits?: HabitOut[];
  /** The habits `GET /v1/today` lists as due (default: all of them). */
  due?: HabitOut[];
  logs?: HabitLogOut[];
  goals?: GoalsOut;
  /** `GET /v1/goals` answers with an error. */
  goalsFail?: boolean;
  settings?: Partial<typeof SETTINGS>;
}

async function renderHome(setup: Setup = {}): Promise<ReturnType<typeof withIndicators>> {
  const habits = setup.habits ?? [DAILY, WEEKLY];
  routeFetch(fetchMock, {
    habits,
    today: todayOut(setup.due ?? habits),
    logs: setup.logs ?? [...thirty('daily', '2026-10-10', '2026-11-09'), logRow('weekly', '2026-11-08', 'done', 60), logRow('weekly', DAY, 'done', 25)],
  });
  const goals = setup.goals ?? plan();
  const server = withIndicators(fetchMock, { settings: setup.settings });
  const next = fetchMock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>;
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const request = input as Request;
    if (new URL(request.url).pathname === '/v1/goals') {
      if (setup.goalsFail) return new Response(JSON.stringify({ detail: 'خطأ' }), { status: 500 });
      return new Response(JSON.stringify(goals), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return next(input);
  });
  render(<HomePage />);
  await screen.findByRole('heading', { level: 1, name: 'الرئيسية' });
  await screen.findByRole('region', { name: 'المتأخر وغير المنجز' });
  return server;
}

const late = (): HTMLElement => screen.getByRole('region', { name: 'المتأخر وغير المنجز' });

/** Three milestones of O1 past their day and a fourth later; none done, so the outcome is under its pace. */
const OVERDUE: GoalsOut = plan({
  outcomes: [outcome('O1', { milestones_total: 4, milestones_done: 0, milestones_due: 3 })],
  milestones: [
    milestone('m1', 'أولى متأخرة', { outcome_code: 'O1', due_date: '2026-11-02' }),
    milestone('m2', 'ثانية متأخرة', { outcome_code: 'O1', due_date: '2026-11-05' }),
    milestone('m3', 'ثالثة متأخرة', { outcome_code: 'O1', due_date: '2026-11-08' }),
    milestone('m4', 'قادمة', { outcome_code: 'O1', due_date: '2027-01-01' }),
  ],
});
/** No milestone and no outcome: nothing can be late in the plan. */
const NOTHING: GoalsOut = plan({ milestones: [], outcomes: [] });

describe('home: «المتأخر وغير المنجز»', () => {
  it('lists the milestones, then the habits, then the goals; five, then «عرض الكل»', async () => {
    await renderHome({ goals: OVERDUE });
    const items = within(late()).getAllByRole('listitem');
    // three milestones, two habits, one goal: six items, five shown
    expect(items).toHaveLength(5);
    expect(items[0]?.textContent).toContain('أولى متأخرة');
    expect(items[1]?.textContent).toContain('ثانية متأخرة');
    expect(items[2]?.textContent).toContain('ثالثة متأخرة');
    expect(items[3]?.textContent).toContain('تمرين');
    expect(items[4]?.textContent).toContain('الإنجليزية');
    fireEvent.click(within(late()).getByRole('button', { name: 'عرض الكل (6)' }));
    const all = within(late()).getAllByRole('listitem');
    expect(all).toHaveLength(6);
    expect(all[5]?.textContent).toContain('الصحة الجسدية');
    expect(within(late()).queryByRole('button', { name: /عرض الكل/ })).toBeNull();
  });

  it('every item has the word «متأخر» and its impact sentence', async () => {
    await renderHome({ goals: OVERDUE });
    const items = within(late()).getAllByRole('listitem');
    for (const item of items) expect(item.textContent).toContain('متأخر');
    expect(items[0]?.textContent).toContain('متأخرة 8 أيام عن موعدها الاثنين، 2 نوفمبر 2026. O1: أُنجز 0 من 3 محطة حان موعدها.');
    expect(items[3]?.textContent).toContain('فاتت أمس. درجة القوة 76: إنجاز اليوم يجعلها 77، وفواته 72.');
    expect(items[4]?.textContent).toContain('يلزم 200 دقيقة في 5 أيام لبلوغ هدف الأسبوع (285)، أي 40 دقيقة يومياً.');
  });

  it('with nothing late it says so', async () => {
    const calm = habit('calm', 'هادئة', { start_day: '2026-11-09' });
    await renderHome({ habits: [calm], logs: [logRow('calm', '2026-11-09'), logRow('calm', DAY)], goals: NOTHING });
    expect(within(late()).getByText('لا متأخرات اليوم.')).toBeTruthy();
    expect(within(late()).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('ticking a late habit takes it out of the section before any answer from the network', async () => {
    await renderHome({ habits: [DAILY], goals: NOTHING });
    const row = within(late()).getByText('تمرين').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { pressed: false }));
    await waitFor(() => expect(within(late()).queryByText('تمرين')).toBeNull());
    expect(within(late()).getByText('لا متأخرات اليوم.')).toBeTruthy();
    const events = await listPending();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ habit_code: 'daily', status: 'done' });
  });

  it('an abstain habit with a slip today appears with the slip sentence, and has no check mark', async () => {
    await renderHome({ habits: [QUIT], logs: [logRow('quit', DAY)], goals: NOTHING });
    const row = within(late()).getByText('الامتناع').closest('li') as HTMLElement;
    expect(row.textContent).toContain('انزلاق مسجَّل اليوم. درجة القوة 36، وبدونه 41.');
    expect(within(row).queryByRole('button', { pressed: false })).toBeNull();
  });

  it('an outcome code inside the sentence is isolated left to right (the day is written in words)', async () => {
    await renderHome({ goals: OVERDUE });
    const first = within(late()).getByText('أولى متأخرة').closest('li') as HTMLElement;
    const isolated = [...first.querySelectorAll('bdi[dir="ltr"]')].map((el) => el.textContent);
    expect(isolated).toEqual(['O1']);
  });

  it('a milestone and a goal are links to their pages', async () => {
    await renderHome({ goals: OVERDUE });
    const first = within(late()).getByText('أولى متأخرة').closest('a');
    expect(first?.getAttribute('href')).toBe('/goals/m1');
  });

  it('an abstain habit stays out of the ring and the badge count', async () => {
    await renderHome({ habits: [DAILY, QUIT], logs: [...thirty('daily', '2026-10-10', '2026-11-09'), logRow('quit', DAY)], goals: NOTHING });
    expect(screen.getByText('0 من 1')).toBeTruthy();
    await waitFor(() => expect(mocks.setBadge).toHaveBeenLastCalledWith(1));
  });
});

describe('home: رسالتي ورؤيتي', () => {
  it('with no text each is an empty pair of brackets, with the link to the settings', () => {
    render(<MissionCard mission="" vision="" />);
    expect(screen.getByText('(رسالتي)')).toBeTruthy();
    expect(screen.getByText('(رؤيتي)')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'كتابتهما من الإعدادات' });
    expect(link.getAttribute('href')).toBe('/settings');
  });

  it('with text it shows it exactly as written', () => {
    const mission = 'أبني حياة   متزنة\nبخطوات صغيرة';
    render(<MissionCard mission={mission} vision="عام 2031: أكون على الطريق" />);
    expect(screen.getByText('عام 2031: أكون على الطريق')).toBeTruthy();
    const shown = screen.getByText((_, el) => el?.classList.contains('mission-text') === true && el.textContent === mission);
    expect(shown).toBeTruthy();
    expect(screen.queryByText('(رسالتي)')).toBeNull();
    expect(screen.queryByRole('link', { name: 'كتابتهما من الإعدادات' })).toBeNull();
  });

  it('the page reads them from the settings and shows them in the second column', async () => {
    await renderHome({ settings: { mission: 'رسالة بكلماتي', vision: '' } });
    const card = await screen.findByRole('region', { name: 'رسالتي ورؤيتي' });
    expect(within(card).getByText('رسالة بكلماتي')).toBeTruthy();
    expect(within(card).getByText('(رؤيتي)')).toBeTruthy();
  });

  it('the page shows the four domain cards', async () => {
    await renderHome();
    for (const name of ['المهني', 'الصحي', 'النفسي', 'العلمي']) {
      expect(await screen.findByRole('heading', { level: 3, name })).toBeTruthy();
    }
  });
});

describe('home: fix round 1', () => {
  // Sunday to Thursday; Thursday 11-12 was missed; today is Friday 11-13 (the fake clock below)
  const WORK = habit('work', 'أيام العمل', { schedule_kind: 'weekdays', weekday_mask: 0b0011111, start_day: '2026-10-10' });
  const workLogs = Array.from({ length: 30 }, (_, i) => fromOrdinal(toOrdinal('2026-10-10') + i))
    .filter((day) => day !== '2026-11-12')
    .map((day) => logRow('work', day));

  it('I-1: a late habit that is not due today is a link to its page, with no check mark and no promise', async () => {
    vi.setSystemTime(new Date('2026-11-13T09:00:00Z'));
    await renderHome({ habits: [WORK], due: [], logs: workLogs, goals: NOTHING });
    const row = within(late()).getByText('أيام العمل').closest('li') as HTMLElement;
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).getByRole('link').getAttribute('href')).toBe('/habits/work');
    expect(row.textContent).toContain('فاتت أمس.');
    expect(row.textContent).not.toContain('إنجاز اليوم');
  });

  it('M-2: when the plan cannot be read the section does not say nothing is late', async () => {
    await renderHome({ habits: [], logs: [], goalsFail: true });
    expect(within(late()).queryByText('لا متأخرات اليوم.')).toBeNull();
    expect(within(late()).getByText(/تعذّرت قراءة الخطة/)).toBeTruthy();
  });

  it('M-2: the plan cannot be read but a habit is late: the habit is listed, and the note stays', async () => {
    await renderHome({ habits: [DAILY], logs: thirty('daily', '2026-10-10', '2026-11-09'), goalsFail: true });
    expect(within(late()).getByText('تمرين')).toBeTruthy();
    expect(within(late()).getByText(/تعذّرت قراءة الخطة/)).toBeTruthy();
  });

  it('M-3: offline with no saved settings, the card says there is no saved copy', () => {
    render(<MissionCard mission="" vision="" unavailable="offline" />);
    expect(screen.getByText('لا نسخة محفوظة بعد')).toBeTruthy();
    expect(screen.queryByText('تعذّرت القراءة الآن.')).toBeNull();
  });

  it('M-3: a refused read keeps its own words', () => {
    render(<MissionCard mission="" vision="" unavailable="error" />);
    expect(screen.getByText('تعذّرت القراءة الآن.')).toBeTruthy();
  });
});
