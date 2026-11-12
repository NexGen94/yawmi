// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readCache } from '../../src/data/cache';
import { todayQueryKey } from '../../src/habits/todayData';
import { setDigits } from '../../src/lib/format';
import HomePage from '../../src/pages/home/index';
import { clearOutbox, closeDb, enqueue, listPending } from '../../src/sync/outbox';
import {
  DAY,
  ENGLISH,
  eveningEntry,
  FREE_1,
  habit,
  morningEntry,
  NOON_RIYADH,
  routeFetch,
  SLEEP_1,
  STORY_HABITS,
  STORY_LOGS,
  todayOut,
  WAKE_1,
} from '../helpers/today-fixtures';

const mocks = vi.hoisted(() => ({
  setBadge: vi.fn(async (_n: number) => undefined),
  dayChange: null as null | ((day: string) => void),
}));

// A real tick starts a 5 s flush timer that would outlive the test.
vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));
vi.mock('../../src/push/subscribe', () => ({ setBadge: mocks.setBadge }));
vi.mock('../../src/lib/today', async (original) => ({
  ...(await original<typeof import('../../src/lib/today')>()),
  onDayChange: (cb: (day: string) => void) => {
    mocks.dayChange = cb;
    return () => {
      mocks.dayChange = null;
    };
  },
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mocks.setBadge.mockClear();
});

afterEach(() => {
  setDigits('latn');
  vi.restoreAllMocks();
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const row = (title: string): HTMLElement => screen.getByText(title).closest('li') as HTMLElement;

async function renderStory(): Promise<void> {
  routeFetch(fetchMock);
  render(<HomePage />);
  await screen.findByText('3 من 6');
}

describe('home: the ink card', () => {
  it('shows «3 من 6» and a ring named with 50', async () => {
    await renderStory();
    expect(screen.getByText('3 من 6')).toBeTruthy();
    const ring = screen.getByRole('img', { name: /50/ });
    expect(ring.getAttribute('aria-label')).toContain('50');
  });

  it('shows the date, the Hijri date and the day of the cycle', async () => {
    await renderStory();
    expect(screen.getByText(/الثلاثاء/)).toBeTruthy();
    expect(screen.getByText(/الدورة 1/)).toBeTruthy();
    expect(screen.getByText(/اليوم 11 من 56/)).toBeTruthy();
  });

  it('calls setBadge with due minus done', async () => {
    await renderStory();
    await waitFor(() => expect(mocks.setBadge).toHaveBeenLastCalledWith(3));
  });
});

describe('home: one-tap habits', () => {
  it('a tick on a yes/no habit queues one habit_logged done and the card says «4 من 6» before any reply', async () => {
    await renderStory();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('4 من 6');
    const events = await listPending();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('habit_logged');
    expect(events[0]?.payload).toMatchObject({ habit_code: SLEEP_1.code, status: 'done' });
    await waitFor(() => expect(mocks.setBadge).toHaveBeenLastCalledWith(2));
  });

  it('«+5» on a duration habit at 25 queues value 30', async () => {
    await renderStory();
    fireEvent.click(within(row('الإنجليزية')).getByRole('button', { name: /^\+5/ }));
    await waitFor(async () => expect(await listPending()).toHaveLength(1));
    const [event] = await listPending();
    expect(event?.payload).toMatchObject({ habit_code: ENGLISH.code, status: 'done', value: 30 });
    expect(await within(row('الإنجليزية')).findByText(/30 من 45 دقيقة/)).toBeTruthy();
  });

  it('«تراجع» discards the queued event and the card goes back to «3 من 6»', async () => {
    await renderStory();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('4 من 6');
    fireEvent.click(screen.getByRole('button', { name: 'تراجع' }));
    await screen.findByText('3 من 6');
    expect(await listPending()).toHaveLength(0);
  });

  it('«تراجع» after the event was sent tells the truth and offers the skip correction', async () => {
    await renderStory();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('4 من 6');
    await clearOutbox(); // the flush took it
    fireEvent.click(screen.getByRole('button', { name: 'تراجع' }));
    await screen.findByText('أُرسل التسجيل؛ التصحيح بتخطي اليوم');
    expect(screen.queryByRole('button', { name: 'تراجع' })).toBeNull();
  });

  it('«تخطي» queues a skip', async () => {
    await renderStory();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { name: /^تخطي/ }));
    await waitFor(async () => expect(await listPending()).toHaveLength(1));
    const [event] = await listPending();
    expect(event?.payload).toMatchObject({ habit_code: SLEEP_1.code, status: 'skip' });
  });
});

describe('home: the habit groups', () => {
  it('draws three groups with their headings and the habits in them', async () => {
    await renderStory();
    for (const title of ['بعد الاستيقاظ', 'خلال اليوم', 'قبل النوم']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    const wake = screen.getByRole('heading', { name: 'بعد الاستيقاظ' }).closest('section') as HTMLElement;
    expect(within(wake).getByText('شرب الماء')).toBeTruthy();
    expect(within(wake).queryByText('المشي')).toBeNull();
  });

  it('does not draw an empty group', async () => {
    routeFetch(fetchMock, { habits: [WAKE_1, FREE_1], logs: [] });
    render(<HomePage />);
    await screen.findByText('0 من 2');
    expect(screen.queryByRole('heading', { name: 'قبل النوم' })).toBeNull();
  });

  it('shows the weekly progress and the need per day under a weekly habit', async () => {
    const weekly = habit('week_english', 'إنجليزية أسبوعية', {
      period: 'week',
      kind: 'duration',
      unit: 'min',
      target_per_period: 285,
    });
    routeFetch(fetchMock, {
      habits: [weekly],
      logs: [{ habit_code: 'week_english', day: '2026-11-08', status: 'done', value: 60 }],
    });
    render(<HomePage />);
    const item = (await screen.findByText('إنجليزية أسبوعية')).closest('li') as HTMLElement;
    expect(within(item).getByText(/60 من 285 دقيقة هذا الأسبوع/)).toBeTruthy();
    expect(within(item).getByText(/المطلوب يومياً: 45 دقيقة/)).toBeTruthy();
  });

  it('shows the outcome code as a badge', async () => {
    await renderStory();
    expect(within(row('شرب الماء')).getByText('O1')).toBeTruthy();
  });
});

describe('home: the morning and evening cards', () => {
  it('without a journal: «لم تُحفظ بعد» and the one prominent button «بدء يومية الصباح»', async () => {
    await renderStory();
    expect(screen.getByText('لم تُحفظ بعد')).toBeTruthy();
    const start = screen.getByRole('link', { name: 'بدء يومية الصباح' });
    expect(start.getAttribute('href')).toBe('/day/morning');
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(start.classList.contains('btn-primary')).toBe(true);
  });

  it('with a morning journal of 90 planned minutes: «حُفظت · 90 دقيقة مقررة» and the prominent button moves to «إغلاق اليوم»', async () => {
    routeFetch(fetchMock, { journal: [morningEntry({ planned_minutes: 90 })] });
    render(<HomePage />);
    await screen.findByText('حُفظت · 90 دقيقة مقررة');
    const close = screen.getByRole('link', { name: 'إغلاق اليوم' });
    expect(close.getAttribute('href')).toBe('/day/evening');
    expect(close.classList.contains('btn-primary')).toBe(true);
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('after the evening journal: «أُغلق اليوم» and no prominent button', async () => {
    routeFetch(fetchMock, { journal: [morningEntry(), eveningEntry()] });
    render(<HomePage />);
    await screen.findByText('أُغلق اليوم');
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(0);
  });

  it('shows a journal that is still in the outbox', async () => {
    routeFetch(fetchMock);
    await enqueue('journal_saved', { part: 'morning', answers: { planned_minutes: 60, priorities: [] } });
    render(<HomePage />);
    await screen.findByText('حُفظت · 60 دقيقة مقررة');
  });
});

describe('home: the day summary', () => {
  it('lists the morning priorities and counts the open ones', async () => {
    routeFetch(fetchMock, {
      journal: [
        morningEntry({
          priorities: [
            { title: 'مراجعة العرض', goal_ref: null, source_id: null },
            { title: 'تمرين المشي', goal_ref: null, source_id: null },
          ],
        }),
      ],
    });
    render(<HomePage />);
    expect(await screen.findByText('مراجعة العرض')).toBeTruthy();
    expect(screen.getByText('تمرين المشي')).toBeTruthy();
    expect(screen.getByText('أولويتان مفتوحتان')).toBeTruthy();
  });

  it('draws the morning insight lines with the number of sources, and says it is an estimate', async () => {
    routeFetch(fetchMock, {
      today: todayOut(STORY_HABITS, {
        insight: {
          lines: ['إنجاز العادات أعلى في أيام المشي.', 'المحطة O1 متأخرة يومين.'],
          priorities: [],
          question: null,
          source_ids: ['a', 'b'],
        },
      }),
    });
    render(<HomePage />);
    expect(await screen.findByText('إنجاز العادات أعلى في أيام المشي.')).toBeTruthy();
    expect(screen.getByText('المحطة O1 متأخرة يومين.')).toBeTruthy();
    expect(screen.getByText(/تقدير/)).toBeTruthy();
    expect(screen.getByText(/استناداً إلى مصدرين/)).toBeTruthy();
  });

  it('insight: null draws no insight section and no error', async () => {
    await renderStory();
    expect(screen.queryByText(/تقدير/)).toBeNull();
    expect(screen.queryByText('تعذّر التحميل')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('home: the later sections have no visible stand-ins', () => {
  it('draws no message, vision or overdue section yet', async () => {
    await renderStory();
    for (const text of ['رسالتي', 'رؤيتي', 'المتأخر وغير المنجز']) expect(screen.queryByText(text)).toBeNull();
  });
});

describe('home: quick access', () => {
  it('offers links to habits and goals and the ask button', async () => {
    await renderStory();
    expect(screen.getByRole('link', { name: 'تسجيل عادة' }).getAttribute('href')).toBe('/habits');
    expect(screen.getByRole('link', { name: 'عادة من هدف' }).getAttribute('href')).toBe('/goals');
    expect(screen.getByRole('button', { name: 'سؤال' })).toBeTruthy();
  });
});

describe('home: midnight', () => {
  it('fetches the new Riyadh day when the day changes with the page open', async () => {
    await renderStory();
    expect(mocks.dayChange).not.toBeNull();
    fetchMock.mockClear();
    routeFetch(fetchMock, { today: todayOut(STORY_HABITS, { day: '2026-11-11' }) });
    await act(async () => {
      mocks.dayChange?.('2026-11-11');
    });
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => (call[0] as Request).url);
      expect(
        urls.some((u) => u.includes('/v1/habit-logs') && u.includes('to=2026-11-11') && u.includes('from=2026-09-10')),
      ).toBe(true);
    });
  });
});

describe('home: the four states come from the route', () => {
  it('loading: skeletons, busy', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    render(<HomePage />);
    expect(document.querySelector('.state-frame')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(3);
    expect(screen.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeTruthy();
  });

  it('empty: «لا عادات مستحقة اليوم» with «عادة جديدة», and the day cards stay', async () => {
    routeFetch(fetchMock, { habits: [], logs: [] });
    render(<HomePage />);
    await screen.findByText('لا عادات مستحقة اليوم');
    expect(screen.getByRole('link', { name: 'عادة جديدة' }).getAttribute('href')).toBe('/habits/new');
    expect(screen.getByText('لم تُحفظ بعد')).toBeTruthy();
  });

  it('error: «تعذّر التحميل» with a retry that reloads', async () => {
    routeFetch(fetchMock, {}, { fail: 500 });
    render(<HomePage />);
    await screen.findByText('تعذّر التحميل');
    routeFetch(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByText('3 من 6');
  });

  it('offline with a saved copy: the copy and «نسخة محفوظة · بلا اتصال»', async () => {
    routeFetch(fetchMock);
    const first = render(<HomePage />);
    await screen.findByText('3 من 6');
    await waitFor(async () => expect(await readCache(todayQueryKey(DAY))).toBeDefined());
    first.unmount();
    routeFetch(fetchMock, {}, { fail: 'network' });
    render(<HomePage />);
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    expect(screen.getByText('3 من 6')).toBeTruthy();
  });

  it('offline without a copy: «لا نسخة محفوظة بعد»', async () => {
    routeFetch(fetchMock, {}, { fail: 'network' });
    render(<HomePage />);
    await screen.findByText('لا نسخة محفوظة بعد');
  });
});

describe('home: a tap on a done habit is never a dead control', () => {
  it('while its event is still in the outbox the tap takes it back', async () => {
    await renderStory();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('4 من 6');
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: true }));
    await screen.findByText('3 من 6');
    expect(await listPending()).toHaveLength(0);
    expect(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false })).toBeTruthy();
  });

  it('a done that the server already holds says so, and queues nothing', async () => {
    await renderStory();
    fireEvent.click(within(row('شرب الماء')).getByRole('button', { pressed: true }));
    await screen.findByText('أُرسل التسجيل؛ التصحيح بتخطي اليوم');
    expect(await listPending()).toHaveLength(0);
    expect(screen.getByText('3 من 6')).toBeTruthy();
  });

  it('the button says which of the two will happen', async () => {
    await renderStory();
    const description = (button: HTMLElement) =>
      (button.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    const sent = within(row('شرب الماء')).getByRole('button', { pressed: true });
    expect(description(sent)).toContain('التصحيح بتخطي اليوم');
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('4 من 6');
    const unsent = within(row('إطفاء الشاشات')).getByRole('button', { pressed: true });
    expect(description(unsent)).toContain('لم يُرسل بعد');
  });
});

describe('home: whole units, and two quick taps', () => {
  it('a weekly duration habit shows and sends whole minutes', async () => {
    const weekly = habit('week_read', 'القراءة الأسبوعية', {
      period: 'week',
      kind: 'duration',
      unit: 'min',
      target_per_period: 93,
    });
    routeFetch(fetchMock, { habits: [weekly], logs: [] });
    render(<HomePage />);
    const item = (await screen.findByText('القراءة الأسبوعية')).closest('li') as HTMLElement;
    expect(within(item).getByText(/المطلوب يومياً: 19 دقيقة/)).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { pressed: false }));
    await waitFor(async () => expect(await listPending()).toHaveLength(1));
    const [event] = await listPending();
    expect(event?.payload).toMatchObject({ habit_code: 'week_read', value: 19 });
  });

  it('two synchronous «+5» taps from 25 end at 35, not 30', async () => {
    await renderStory();
    const plus = within(row('الإنجليزية')).getByRole('button', { name: /^\+5/ });
    fireEvent.click(plus);
    fireEvent.click(plus);
    await waitFor(async () => expect(await listPending()).toHaveLength(2));
    const events = await listPending();
    expect(events.map((e) => (e.payload as { value?: number }).value)).toEqual([30, 35]);
    expect(await within(row('الإنجليزية')).findByText(/35 من 45 دقيقة/)).toBeTruthy();
  });
});

describe('home: the note stays until the next action or a dismissal', () => {
  it('sets no 8-second timer, and the next log replaces the note', async () => {
    const delays: unknown[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms);
      return original(fn, ms, ...rest);
    }) as typeof setTimeout);
    await renderStory();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('سُجّل: إطفاء الشاشات');
    expect(delays).not.toContain(8000);
    fireEvent.click(within(row('المشي')).getByRole('button', { name: /^تخطي/ }));
    await screen.findByText('سُجّل تخطّي اليوم: المشي');
    expect(screen.queryByText('سُجّل: إطفاء الشاشات')).toBeNull();
  });

  it('can be dismissed with its close button', async () => {
    await renderStory();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('سُجّل: إطفاء الشاشات');
    fireEvent.click(document.querySelector('.toast .icon-btn') as HTMLElement);
    await waitFor(() => expect(screen.queryByText('سُجّل: إطفاء الشاشات')).toBeNull());
  });

  it('after a keyboard tap focus stays on the row (it never jumps to «تراجع»), and the notice is a button in the tab order', async () => {
    await renderStory();
    const tick = within(row('إطفاء الشاشات')).getByRole('button', { pressed: false });
    tick.focus();
    fireEvent.keyDown(tick, { key: 'Enter' });
    fireEvent.click(tick);
    const undo = await screen.findByRole('button', { name: 'تراجع' });
    await screen.findByText('4 من 6');
    expect(document.activeElement).not.toBe(undo);
    expect(row('إطفاء الشاشات').contains(document.activeElement)).toBe(true);
    expect(undo.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it('Escape dismisses the notice and focus stays where it was', async () => {
    await renderStory();
    const tick = within(row('إطفاء الشاشات')).getByRole('button', { pressed: false });
    tick.focus();
    fireEvent.keyDown(tick, { key: 'Enter' });
    fireEvent.click(tick);
    await screen.findByText('سُجّل: إطفاء الشاشات');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('سُجّل: إطفاء الشاشات')).toBeNull());
    expect(row('إطفاء الشاشات').contains(document.activeElement)).toBe(true);
    // The tick itself stays: only the note went.
    await screen.findByText('4 من 6');
  });

  it('Escape with no notice does nothing', async () => {
    await renderStory();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByText('3 من 6')).toBeTruthy();
  });

  it('after a mouse tap focus stays where it is', async () => {
    await renderStory();
    const tick = within(row('إطفاء الشاشات')).getByRole('button', { pressed: false });
    fireEvent.pointerDown(tick);
    fireEvent.click(tick);
    await screen.findByRole('button', { name: 'تراجع' });
    expect(document.activeElement?.className ?? '').not.toContain('toast-action');
  });
});

describe('home: the ring, the badge and abstain habits', () => {
  const abstain = habit('no_sugar', 'ترك السكر', { polarity: 'abstain' });

  it('an abstain habit is outside the ring («3 من 6», not «4 من 7») and outside the badge', async () => {
    routeFetch(fetchMock, { habits: [...STORY_HABITS, abstain] });
    render(<HomePage />);
    await screen.findByText('3 من 6');
    await waitFor(() => expect(mocks.setBadge).toHaveBeenLastCalledWith(3));
  });

  it('a slip today changes neither the ring nor the badge', async () => {
    routeFetch(fetchMock, {
      habits: [...STORY_HABITS, abstain],
      logs: [...STORY_LOGS, { habit_code: 'no_sugar', day: DAY, status: 'done', value: null }],
    });
    render(<HomePage />);
    await screen.findByText('3 من 6');
    await waitFor(() => expect(mocks.setBadge).toHaveBeenLastCalledWith(3));
  });
});

describe('home: details', () => {
  it('after the day is closed without a morning journal no button is prominent', async () => {
    routeFetch(fetchMock, { journal: [eveningEntry()] });
    render(<HomePage />);
    await screen.findByText('أُغلق اليوم');
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(0);
  });

  it('writes the open-priorities count and the sources in the digits setting', async () => {
    setDigits('arab');
    routeFetch(fetchMock, {
      today: todayOut(STORY_HABITS, {
        insight: { lines: ['سطر'], priorities: [], question: null, source_ids: ['a', 'b', 'c'] },
      }),
      journal: [
        morningEntry({
          priorities: ['أ', 'ب', 'ج'].map((title) => ({ title, goal_ref: null, source_id: null })),
        }),
      ],
    });
    render(<HomePage />);
    expect(await screen.findByText('٣ أولويات مفتوحة')).toBeTruthy();
    expect(screen.getByText('استناداً إلى ٣ مصادر')).toBeTruthy();
  });

  it('does not load the push module in the first load (setBadge is imported on demand)', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../src/pages/home/index.tsx'), 'utf8');
    expect(source).not.toMatch(/from\s+['"][./]*push\/subscribe['"]/);
    expect(source).toMatch(/import\(['"][./]*push\/subscribe['"]\)/);
  });
});
