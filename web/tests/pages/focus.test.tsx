// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeCache } from '../../src/data/cache';
import { logHabit } from '../../src/data/events';
import { plansQueryKey, sessionsQueryKey } from '../../src/focus/data';
import { loadEnding, loadSession } from '../../src/focus/timer';
import { setDigits } from '../../src/lib/format';
import FocusPage from '../../src/pages/focus/index';
import { discardWindow } from '../../src/pages/focus/useSession';
import { clearOutbox, closeDb, listPending, type OutboxEvent } from '../../src/sync/outbox';
import { PLAN_ID, PLAN_ID_2, plan, routeFocus, sessionOut } from '../helpers/focus-fixtures';
import { DAY, ENGLISH, NOON_RIYADH } from '../helpers/today-fixtures';

vi.mock('../../src/data/events', async (original) => {
  const real = await original<typeof import('../../src/data/events')>();
  return { ...real, logHabit: vi.fn(real.logHabit) };
});
vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

let fetchMock: ReturnType<typeof vi.fn>;
const at = (minutes: number, seconds = 0): number => Date.parse(NOON_RIYADH) + minutes * 60_000 + seconds * 1000;

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  history.replaceState(null, '', '/focus');
});

afterEach(() => {
  setDigits('latn');
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPage(): void {
  render(
    <LocationProvider>
      <FocusPage />
    </LocationProvider>,
  );
}

/** Moves the clock and lets the page read it (the same thing a tick, a wake-up or a focus does). */
async function moveClockTo(ms: number): Promise<void> {
  vi.setSystemTime(new Date(ms));
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const ofType = async (type: OutboxEvent['type']): Promise<OutboxEvent[]> => (await listPending()).filter((e) => e.type === type);
const click = (name: string | RegExp): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

async function start(): Promise<void> {
  await screen.findByRole('button', { name: 'بدء' });
  click('بدء');
  await screen.findByRole('timer');
}

describe('the session starts with one event and survives a reload', () => {
  it('«بدء» queues one focus_started with the planned minutes and nothing else', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    const events = await ofType('focus_started');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ planned_minutes: 25 });
    expect((await listPending()).filter((e) => e.type !== 'focus_started')).toEqual([]);
  });

  it('keeps the session in kv under its start time, and a fresh page restores it', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    expect(await loadSession()).toEqual({ startedAt: new Date(NOON_RIYADH).toISOString(), plannedMinutes: 25 });
    document.body.replaceChildren();
    // The tab slept for ten minutes and the page was reloaded.
    await moveClockTo(at(10));
    await act(async () => {
      renderPage();
    });
    expect(await screen.findByRole('timer')).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toBe('15:00');
    expect(screen.queryByRole('button', { name: 'بدء' })).toBeNull();
    expect(await ofType('focus_started')).toHaveLength(1);
  });

  it('the clock is read from the timestamps: one tick after a long sleep shows the whole gap', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    expect(screen.getByRole('timer').textContent).toBe('25:00');
    vi.setSystemTime(new Date(at(7)));
    // No event: the page's own one-second tick finds the new time.
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('18:00'), { timeout: 3000 });
  });

  it('after the planned time the counter goes on upwards and «تمديد» appears', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    expect(screen.queryByRole('button', { name: 'تمديد' })).toBeNull();
    await moveClockTo(at(31));
    expect(screen.getByRole('timer').textContent).toBe('+06:00');
    expect(screen.getByRole('button', { name: 'تمديد' })).toBeTruthy();
  });

  it('«تمديد» adds five minutes and the session is running again', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(26));
    click('تمديد');
    await waitFor(() => expect(screen.getByRole('timer').textContent).toBe('04:00'));
    expect((await loadSession())?.plannedMinutes).toBe(30);
  });
});

describe('ending a session', () => {
  it('stopping at 12 of 25 records 12, the plant is at stage 2, and no word blames', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(12));
    expect(screen.getByRole('img', { name: /نبتة التركيز.*المرحلة 2 من 4/ })).toBeTruthy();
    click('إنهاء');
    await screen.findByRole('button', { name: 'حفظ الجلسة' });
    expect(screen.getByText(/12 دقيقة من 25/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /المرحلة 2 من 4/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/فشل|لم تُكمل|لم تكمل|تقصير|ناقص|مقصّر|خسارة/);
    click('حفظ الجلسة');
    await waitFor(async () => expect(await ofType('focus_ended')).toHaveLength(1));
    const [ended] = await ofType('focus_ended');
    expect(ended?.payload).toMatchObject({
      planned_minutes: 25,
      actual_minutes: 12,
      started_at: new Date(NOON_RIYADH).toISOString(),
      ended_at: new Date(at(12)).toISOString(),
    });
    expect(await loadSession()).toBeNull();
    expect(await screen.findByRole('button', { name: 'بدء' })).toBeTruthy();
  });

  it('the moment of «إنهاء» is kept: the time does not run on while the wrap-up is open or after a reload', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(12));
    click('إنهاء');
    await screen.findByRole('button', { name: 'حفظ الجلسة' });
    expect(await loadEnding()).toBe(new Date(at(12)).toISOString());
    document.body.replaceChildren();
    await moveClockTo(at(40));
    await act(async () => {
      renderPage();
    });
    await screen.findByRole('button', { name: 'حفظ الجلسة' });
    expect(screen.getByText(/12 دقيقة من 25/)).toBeTruthy();
  });

  it('a session ended at 31 of 25 queues one focus_ended with 31 minutes', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(31));
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ الجلسة' }));
    await waitFor(async () => expect(await ofType('focus_ended')).toHaveLength(1));
    expect((await ofType('focus_ended'))[0]?.payload).toMatchObject({ planned_minutes: 25, actual_minutes: 31 });
  });

  it('the focus rating (1 to 5) and the next step (up to 500 characters) go into the payload', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(25));
    click('إنهاء');
    const rating = await screen.findByRole('radiogroup', { name: 'تقييم التركيز' });
    expect(within(rating).getAllByRole('radio').map((r) => r.textContent)).toEqual(['1', '2', '3', '4', '5']);
    fireEvent.click(within(rating).getByRole('radio', { name: '4' }));
    const next = screen.getByLabelText('الخطوة التالية') as HTMLTextAreaElement | HTMLInputElement;
    expect(next.getAttribute('maxlength')).toBe('500');
    fireEvent.input(next, { target: { value: 'مراجعة الفصل الثالث' } });
    click('حفظ الجلسة');
    await waitFor(async () => expect(await ofType('focus_ended')).toHaveLength(1));
    expect((await ofType('focus_ended'))[0]?.payload).toMatchObject({
      focus_rating: 4,
      next_step: 'مراجعة الفصل الثالث',
    });
  });

  it('a rating and a next step left empty are not sent', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(25));
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ الجلسة' }));
    await waitFor(async () => expect(await ofType('focus_ended')).toHaveLength(1));
    const payload = (await ofType('focus_ended'))[0]?.payload ?? {};
    expect('focus_rating' in payload).toBe(false);
    expect('next_step' in payload).toBe(false);
  });

  it('«تجاهل الجلسة» keeps the session for an undo window, and «تراجع» brings the wrap-up back with the same minutes', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(12));
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'تجاهل الجلسة' }));
    const undo = await screen.findByRole('button', { name: 'تراجع' });
    // Nothing is thrown away yet: the session and its frozen end are still on the device.
    expect(await loadSession()).not.toBeNull();
    expect(await loadEnding()).toBe(new Date(at(12)).toISOString());
    fireEvent.click(undo);
    await screen.findByRole('button', { name: 'حفظ الجلسة' });
    expect(screen.getByText(/12 دقيقة من 25/)).toBeTruthy();
    expect(await loadSession()).not.toBeNull();
    expect(await ofType('focus_ended')).toEqual([]);
  });

  it('focus follows the controls: «تراجع» takes it when the discard starts, and «تجاهل الجلسة» gets it back', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'تجاهل الجلسة' }));
    const undo = await screen.findByRole('button', { name: 'تراجع' });
    await waitFor(() => expect(document.activeElement).toBe(undo));
    fireEvent.click(undo);
    const discard = await screen.findByRole('button', { name: 'تجاهل الجلسة' });
    await waitFor(() => expect(document.activeElement).toBe(discard));
  });

  it('after the window the session is gone, nothing was queued, and the page is free', async () => {
    const before = discardWindow.ms;
    discardWindow.ms = 60;
    try {
      routeFocus(fetchMock);
      renderPage();
      await start();
      click('إنهاء');
      fireEvent.click(await screen.findByRole('button', { name: 'تجاهل الجلسة' }));
      await screen.findByRole('button', { name: 'بدء' });
      expect(await ofType('focus_ended')).toEqual([]);
      expect(await loadSession()).toBeNull();
      expect(await loadEnding()).toBeNull();
    } finally {
      discardWindow.ms = before;
    }
  });

  it('the undo window is the usual five seconds', () => {
    expect(discardWindow.ms).toBe(5000);
  });

  it('a session within an hour of its planned time is not offered the planned-time save', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(25 + 30));
    click('إنهاء');
    await screen.findByRole('button', { name: 'حفظ الجلسة' });
    expect(screen.queryByRole('button', { name: 'حفظ بالمدة المقررة' })).toBeNull();
  });

  it('over an hour past the planned time, «حفظ بالمدة المقررة» records the planned minutes, ending at the planned time', async () => {
    routeFocus(fetchMock);
    renderPage();
    await start();
    await moveClockTo(at(25 + 61));
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ بالمدة المقررة' }));
    await waitFor(async () => expect(await ofType('focus_ended')).toHaveLength(1));
    expect((await ofType('focus_ended'))[0]?.payload).toMatchObject({
      planned_minutes: 25,
      actual_minutes: 25,
      started_at: new Date(at(0)).toISOString(),
      ended_at: new Date(at(25)).toISOString(),
    });
    expect(await loadSession()).toBeNull();
  });
});

describe('the duration habit of a plan', () => {
  const plans = [plan({ id: PLAN_ID, title_ar: 'الإنجليزية العميقة', minutes: 25, habit_code: ENGLISH.code, goal_ref: 'O7' })];

  it('?plan fills the minutes, the goal and the habit, and the payload carries plan_id', async () => {
    history.replaceState(null, '', `/focus?plan=${PLAN_ID}`);
    routeFocus(fetchMock, { plans, withGoals: true });
    renderPage();
    await screen.findByText(/الإنجليزية العميقة/);
    await screen.findByText(/الإنجليزية \(أولوية عالية\)/); // the goal, by its title
    await start();
    await screen.findByRole('timer');
    expect((await ofType('focus_started'))[0]?.payload).toEqual({
      planned_minutes: 25,
      goal_ref: 'O7',
      habit_code: ENGLISH.code,
      plan_id: PLAN_ID,
    });
  });

  it('with 25 minutes already logged today, ending at 31 adds one habit_logged with value 56', async () => {
    history.replaceState(null, '', `/focus?plan=${PLAN_ID}`);
    routeFocus(fetchMock, { plans });
    renderPage();
    await screen.findByText(/الإنجليزية العميقة/);
    // The habits of the day are read before the session ends.
    await waitFor(() => expect(fetchMock.mock.calls.some(([r]) => new URL((r as Request).url).pathname === '/v1/habit-logs')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await start();
    await screen.findByRole('timer');
    await moveClockTo(at(31));
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ الجلسة' }));
    await waitFor(async () => expect(await ofType('habit_logged')).toHaveLength(1));
    expect((await ofType('focus_ended'))).toHaveLength(1);
    expect((await ofType('habit_logged'))[0]?.payload).toMatchObject({ habit_code: ENGLISH.code, status: 'done', value: 56 });
    const types = (await listPending()).map((e) => e.type);
    expect(types).toEqual(['focus_started', 'focus_ended', 'habit_logged']);
    expect((await ofType('focus_ended'))[0]?.payload).toMatchObject({ habit_code: ENGLISH.code, goal_ref: 'O7', actual_minutes: 31 });
  });
});

describe('the habit minutes and the order of the save', () => {
  const plans = [plan({ id: PLAN_ID, title_ar: 'الإنجليزية العميقة', minutes: 25, habit_code: ENGLISH.code })];

  async function loadPlanPage(): Promise<void> {
    history.replaceState(null, '', `/focus?plan=${PLAN_ID}`);
    routeFocus(fetchMock, { plans });
    renderPage();
    await screen.findByText(/الإنجليزية العميقة/);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([r]) => new URL((r as Request).url).pathname === '/v1/habit-logs')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('the habit log of a same-day session has no day of its own', async () => {
    await loadPlanPage();
    await start();
    await screen.findByRole('timer');
    await moveClockTo(at(31));
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ الجلسة' }));
    await waitFor(async () => expect(await ofType('habit_logged')).toHaveLength(1));
    expect('day' in ((await ofType('habit_logged'))[0]?.payload ?? {})).toBe(false);
  });

  it('the session is cleared as soon as focus_ended is queued: a habit log that fails cannot leave a second save', async () => {
    await loadPlanPage();
    await start();
    await screen.findByRole('timer');
    await moveClockTo(at(31));
    click('إنهاء');
    const save = await screen.findByRole('button', { name: 'حفظ الجلسة' });
    vi.mocked(logHabit).mockImplementationOnce(async () => {
      throw new Error('indexeddb');
    });
    fireEvent.click(save);
    await screen.findByRole('button', { name: 'بدء' });
    expect(await ofType('focus_ended')).toHaveLength(1);
    expect(await ofType('habit_logged')).toEqual([]);
    expect(await loadSession()).toBeNull();
    expect(screen.getByText(/لم تُسجَّل الدقائق في العادة المرتبطة/)).toBeTruthy();
  });

  it("a session that began before midnight logs the habit on the day it began, with that day's value", async () => {
    vi.setSystemTime(new Date('2026-11-10T20:50:00Z')); // 23:50 in Riyadh
    await loadPlanPage();
    await start();
    await screen.findByRole('timer');
    await moveClockTo(Date.parse('2026-11-10T21:21:00Z')); // 00:21 the next day
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ الجلسة' }));
    await waitFor(async () => expect(await ofType('habit_logged')).toHaveLength(1));
    expect((await ofType('habit_logged'))[0]?.payload).toMatchObject({
      habit_code: ENGLISH.code,
      status: 'done',
      value: 56,
      day: DAY,
    });
  });
});

describe('the goal of the link', () => {
  it('?goal fills goal_ref and shows the goal by its title', async () => {
    history.replaceState(null, '', '/focus?goal=O7');
    routeFocus(fetchMock, { withGoals: true });
    renderPage();
    expect(await screen.findByText(/الإنجليزية \(أولوية عالية\)/)).toBeTruthy();
    await start();
    await screen.findByRole('timer');
    expect((await ofType('focus_started'))[0]?.payload).toEqual({ planned_minutes: 25, goal_ref: 'O7' });
  });

  it('a link to a goal the plan does not know still keeps the reference', async () => {
    history.replaceState(null, '', '/focus?goal=abc-123');
    routeFocus(fetchMock);
    renderPage();
    await screen.findByRole('button', { name: 'بدء' });
    await start();
    await screen.findByRole('timer');
    expect((await ofType('focus_started'))[0]?.payload).toEqual({ planned_minutes: 25, goal_ref: 'abc-123' });
  });
});

describe('the three durations and the favourite combinations', () => {
  it('offers 25, 50 and 90 minutes as a preference, not a rule', async () => {
    routeFocus(fetchMock);
    renderPage();
    const group = await screen.findByRole('radiogroup', { name: 'المدة' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['25 دقيقة', '50 دقيقة', '90 دقيقة']);
    expect(screen.getByText(/تفضيل، لا قاعدة/)).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: '50 دقيقة' }));
    await start();
    await screen.findByRole('timer');
    expect((await ofType('focus_started'))[0]?.payload).toEqual({ planned_minutes: 50 });
  });

  it('a favourite combination starts with one tap', async () => {
    routeFocus(fetchMock, { plans: [plan({ favorite: true, goal_ref: 'O7' }), plan({ id: 'x', title_ar: 'غير مفضلة', favorite: false })] });
    renderPage();
    const group = await screen.findByRole('group', { name: 'التركيبات المفضلة' });
    expect(within(group).queryByText(/غير مفضلة/)).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: /عمل عميق/ }));
    await screen.findByRole('timer');
    const events = await ofType('focus_started');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ planned_minutes: 90, goal_ref: 'O7', plan_id: PLAN_ID });
  });
});

describe('plans', () => {
  it('a ready template creates a plan with POST', async () => {
    const requests = routeFocus(fetchMock);
    renderPage();
    const templates = await screen.findByRole('group', { name: 'قوالب جاهزة' });
    fireEvent.click(within(templates).getByRole('button', { name: 'جلسة صباحية · 25 دقيقة' }));
    await waitFor(() => expect(requests.posts).toHaveLength(1));
    expect(requests.posts[0]?.body).toMatchObject({ title_ar: 'جلسة صباحية', minutes: 25 });
    // The list is read again and shows the plan.
    const list = await screen.findByRole('region', { name: 'خطط التركيز' });
    expect(await within(list).findByText('جلسة صباحية')).toBeTruthy();
  });

  it('lists the plans with their minutes, and a favourite toggle that patches', async () => {
    const requests = routeFocus(fetchMock, { plans: [plan({ weekday_mask: 0b0000101, start_time: '09:00' })] });
    renderPage();
    const list = await screen.findByRole('region', { name: 'خطط التركيز' });
    expect(within(list).getByText('عمل عميق')).toBeTruthy();
    expect(within(list).getAllByText(/90 دقيقة/).length).toBeGreaterThan(0);
    fireEvent.click(within(list).getByRole('button', { name: 'تفضيل عمل عميق' }));
    await waitFor(() => expect(requests.patches).toHaveLength(1));
    expect(requests.patches[0]?.body).toEqual({ favorite: true });
  });

  it('the scheduled blocks name the days and the time', async () => {
    routeFocus(fetchMock, { plans: [plan({ weekday_mask: 0b0000101, start_time: '09:00' })] });
    renderPage();
    const blocks = await screen.findByRole('region', { name: 'الكتل المجدولة' });
    expect(within(blocks).getByText(/الأحد/)).toBeTruthy();
    expect(within(blocks).getByText(/الثلاثاء/)).toBeTruthy();
    expect(within(blocks).getByText(/09:00/)).toBeTruthy();
  });

  it('writing a plan needs a connection and says so', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try {
      const requests = routeFocus(fetchMock);
      renderPage();
      const templates = await screen.findByRole('group', { name: 'قوالب جاهزة' });
      const button = within(templates).getByRole('button', { name: 'جلسة صباحية · 25 دقيقة' });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getAllByText('يحتاج اتصالاً').length).toBeGreaterThan(0);
      expect(requests.posts).toEqual([]);
      // The session itself does not need the network.
      expect(((await screen.findByRole('button', { name: 'بدء' })) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, 'onLine');
    }
  });
});

describe('the score and the hours', () => {
  const sessions = [
    sessionOut('2026-11-10T06:40:00Z', '2026-11-10T07:30:00Z', { actual_minutes: 45, id: '00000000-0000-7000-8000-0000000000b2' }),
  ];

  it('shows «50 · 45 من 90 دقيقة · للوعي الذاتي» when the morning planned 90', async () => {
    routeFocus(fetchMock, {
      sessions,
      journal: [
        {
          day: DAY,
          part: 'morning',
          logged_at: '2026-11-10T04:00:00Z',
          answers: { priorities: [], gratitude: [], planned_minutes: 90 },
        },
      ],
    });
    renderPage();
    const card = await screen.findByRole('region', { name: 'درجة التركيز' });
    await waitFor(() => expect(card.textContent).toContain('50'));
    expect(card.textContent).toContain('45 من 90 دقيقة');
    expect(card.textContent).toContain('للوعي الذاتي');
  });

  it('without any target there is no score, only the minutes, and no made-up number', async () => {
    routeFocus(fetchMock, { sessions });
    renderPage();
    const card = await screen.findByRole('region', { name: 'درجة التركيز' });
    await waitFor(() => expect(card.textContent).toContain('45 دقيقة'));
    expect(card.textContent).toContain('لا هدف يومي للتركيز بعد');
    expect(card.textContent).not.toMatch(/\b\d+\s*·\s*45/);
  });

  it('the hour bars name the hour with the most focus', async () => {
    routeFocus(fetchMock, { sessions });
    renderPage();
    const chart = await screen.findByRole('img', { name: /توزيع ساعات التركيز/ });
    expect(chart.getAttribute('aria-label')).toContain('10:00');
    expect(chart.getAttribute('aria-label')).toContain('30 دقيقة');
  });

  it('an ended session still in the outbox counts at once', async () => {
    routeFocus(fetchMock, { sessions: [] });
    renderPage();
    await start();
    await moveClockTo(at(25));
    click('إنهاء');
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ الجلسة' }));
    const card = await screen.findByRole('region', { name: 'درجة التركيز' });
    await waitFor(() => expect(card.textContent).toContain('25 دقيقة'));
  });
});

describe('the four states', () => {
  it('loading: skeletons and aria-busy for the data, while the timer is already usable', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    renderPage();
    expect(document.querySelector('.state-frame[aria-busy="true"]')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'بدء' })).toBeTruthy();
  });

  it('empty: says what is missing and offers the templates', async () => {
    routeFocus(fetchMock, { plans: [], sessions: [] });
    renderPage();
    expect(await screen.findByText(/لا خطط ولا جلسات بعد/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'قوالب جاهزة' })).toBeTruthy();
  });

  it('error: «تعذّر التحميل» with «إعادة المحاولة» and no raw code', async () => {
    routeFocus(fetchMock, {}, { fail: 500 });
    renderPage();
    expect(await screen.findByText('تعذّر التحميل')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/HTTP|500/);
    // The timer is not held back by the data.
    expect(await screen.findByRole('button', { name: 'بدء' })).toBeTruthy();
  });

  it('offline with a saved copy: the badge «نسخة محفوظة · بلا اتصال»', async () => {
    await writeCache(plansQueryKey, [plan()]);
    await writeCache(sessionsQueryKey(DAY), []);
    routeFocus(fetchMock, {}, { fail: 'network' });
    renderPage();
    expect(await screen.findByText('نسخة محفوظة · بلا اتصال')).toBeTruthy();
    expect(screen.getByText('عمل عميق')).toBeTruthy();
  });

  it('offline with no copy: «لا نسخة محفوظة بعد», and a session can still begin', async () => {
    routeFocus(fetchMock, {}, { fail: 'network' });
    renderPage();
    expect(await screen.findByText('لا نسخة محفوظة بعد')).toBeTruthy();
    await start();
    expect(await screen.findByRole('timer')).toBeTruthy();
    expect(await ofType('focus_started')).toHaveLength(1);
  });
});

describe('digits', () => {
  it('the clock and the minutes follow the digits setting', async () => {
    setDigits('arab');
    routeFocus(fetchMock);
    renderPage();
    const group = await screen.findByRole('radiogroup', { name: 'المدة' });
    expect(within(group).getByRole('radio', { name: /٢٥/ })).toBeTruthy();
    await start();
    expect((await screen.findByRole('timer')).textContent).toBe('٢٥:٠٠');
  });
});

describe('the daily target of the settings', () => {
  const sessions = [
    sessionOut('2026-11-10T06:40:00Z', '2026-11-10T07:25:00Z', { actual_minutes: 45, id: '00000000-0000-7000-8000-0000000000b2' }),
  ];

  it('with focus_daily_target_min set and no morning plan, the score is measured against it', async () => {
    routeFocus(fetchMock, { sessions, settings: { focus_daily_target_min: 120 } });
    renderPage();
    const card = await screen.findByRole('region', { name: 'درجة التركيز' });
    await waitFor(() => expect(card.textContent).toContain('38'));
    expect(card.textContent).toContain('45 من 120 دقيقة · للوعي الذاتي');
  });

  it('with the target cleared (null) there is no score again', async () => {
    routeFocus(fetchMock, { sessions, settings: { focus_daily_target_min: null } });
    renderPage();
    const card = await screen.findByRole('region', { name: 'درجة التركيز' });
    await waitFor(() => expect(card.textContent).toContain('45 دقيقة'));
    expect(card.textContent).toContain('لا هدف يومي للتركيز بعد');
  });

  it('the note without a target names both places a target can come from', async () => {
    routeFocus(fetchMock, { sessions });
    renderPage();
    const card = await screen.findByRole('region', { name: 'درجة التركيز' });
    await waitFor(() => expect(card.textContent).toContain('يومية الصباح'));
    expect(card.textContent).toContain('الإعدادات');
  });
});

describe('stopped plans', () => {
  const stopped = plan({ id: PLAN_ID_2, title_ar: 'خطة قديمة', minutes: 40, active: false });

  it('are listed apart, and «تفعيل» brings one back with a PATCH', async () => {
    const requests = routeFocus(fetchMock, { plans: [plan(), stopped] });
    renderPage();
    const list = await screen.findByRole('region', { name: 'الخطط الموقوفة' });
    expect(within(list).getByText('خطة قديمة')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'تفعيل خطة قديمة' }));
    await waitFor(() => expect(requests.patches).toHaveLength(1));
    expect(requests.patches[0]?.body).toEqual({ active: true });
    const active = await screen.findByRole('region', { name: 'خطط التركيز' });
    expect(await within(active).findByText('خطة قديمة')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'الخطط الموقوفة' })).toBeNull());
  });

  it('are not shown when there is none', async () => {
    routeFocus(fetchMock, { plans: [plan()] });
    renderPage();
    await screen.findByRole('region', { name: 'خطط التركيز' });
    expect(screen.queryByRole('region', { name: 'الخطط الموقوفة' })).toBeNull();
  });

  it('«إيقاف» moves a plan into the stopped list', async () => {
    routeFocus(fetchMock, { plans: [plan()] });
    renderPage();
    const list = await screen.findByRole('region', { name: 'خطط التركيز' });
    fireEvent.click(within(list).getByRole('button', { name: 'إيقاف عمل عميق' }));
    const stoppedList = await screen.findByRole('region', { name: 'الخطط الموقوفة' });
    expect(within(stoppedList).getByText('عمل عميق')).toBeTruthy();
  });
});

describe('numbers in the digits of the setting', () => {
  it('the window of the hours, the rating scale and the minutes of the plan form use the digits setting', async () => {
    setDigits('arab');
    routeFocus(fetchMock, { plans: [plan()] });
    renderPage();
    expect(await screen.findByText(/آخر ٢٨ يوماً/)).toBeTruthy();
    // an invalid number of minutes in the plan form
    fireEvent.input(screen.getByLabelText('عنوان الخطة'), { target: { value: 'خطة' } });
    fireEvent.input(screen.getByLabelText('الدقائق'), { target: { value: '3' } });
    fireEvent.submit(screen.getByRole('button', { name: 'حفظ الخطة' }).closest('form') as HTMLFormElement);
    expect((await screen.findByRole('alert')).textContent).toBe('المدة من ٥ إلى ٢٤٠ دقيقة');
    // the rating scale of the wrap-up
    fireEvent.click(await screen.findByRole('button', { name: 'بدء' }));
    await screen.findByRole('timer');
    click('إنهاء');
    await screen.findByRole('button', { name: 'حفظ الجلسة' });
    expect(screen.getByText(/من ١ \(أقل تركيزاً\) إلى ٥ \(أكثر تركيزاً\)/)).toBeTruthy();
  });
});

afterEach(async () => {
  await clearOutbox().catch(() => undefined);
});
