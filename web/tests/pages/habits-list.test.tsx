// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readCache } from '../../src/data/cache';
import { todayQueryKey } from '../../src/habits/todayData';
import { setDigits } from '../../src/lib/format';
import HabitsPage from '../../src/pages/habits/index';
import { clearOutbox, closeDb, listPending } from '../../src/sync/outbox';
import { DAY, habit, type HabitLogOut, type HabitOut, NOON_RIYADH, routeFetch, todayOut } from '../helpers/today-fixtures';

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

// Tuesday 2026-11-10. The habits, and the state each one has on that day:
//   شرب الماء active · مراجعة الخطة late · المشي done · الإنجليزية الأسبوعية late · إطفاء الشاشات active
//   ترك السكر (abstain) active · مشي أسبوعي active · تحدٍّ ended · عادة قادمة upcoming · عادة قديمة archived
//   يوم السبت: live, but not scheduled on a Tuesday.
const WATER = habit('wake_water', 'شرب الماء', { anchor: 'after_wake', outcome: 'O1' });
const PLAN = habit('wake_plan', 'مراجعة الخطة', { anchor: 'after_wake' });
const WALK = habit('walk', 'المشي', { anchor: 'free' });
const ENGLISH_WEEK = habit('english', 'الإنجليزية الأسبوعية', {
  anchor: 'free',
  kind: 'duration',
  unit: 'min',
  period: 'week',
  target_per_period: 285,
});
const SCREENS = habit('sleep_screen', 'إطفاء الشاشات', { anchor: 'before_sleep' });
const SUGAR = habit('no_sugar', 'ترك السكر', { anchor: 'free', polarity: 'abstain', identity_text: 'أنا شخص لا يحتاج السكر' });
const WEEK_WALK = habit('week_walk', 'مشي أسبوعي', { anchor: 'free', period: 'week', target_per_period: 5 });
const CHALLENGE = habit('challenge', 'تحدٍّ', { start_day: '2026-10-01', end_day: '2026-10-30' });
const LATER = habit('later', 'عادة قادمة', { start_day: '2026-11-15' });
const OLD = habit('old', 'عادة قديمة', { active: false });
const SATURDAY = habit('sat', 'يوم السبت', { schedule_kind: 'weekdays', weekday_mask: 64 });

const HABITS: HabitOut[] = [WATER, PLAN, WALK, ENGLISH_WEEK, SCREENS, SUGAR, WEEK_WALK, CHALLENGE, LATER, OLD, SATURDAY];
const DUE: HabitOut[] = [WATER, PLAN, WALK, ENGLISH_WEEK, SCREENS, SUGAR, WEEK_WALK];

const done = (code: string, day: string, value: number | null = null): HabitLogOut => ({ habit_code: code, day, status: 'done', value });
const LOGS: HabitLogOut[] = [
  done('wake_water', '2026-11-09'),
  done('wake_plan', '2026-11-08'),
  done('walk', '2026-11-09'),
  done('walk', DAY),
  done('english', '2026-11-08', 60),
  done('english', DAY, 25),
  done('sleep_screen', '2026-11-09'),
  done('week_walk', '2026-11-08'),
  done('week_walk', '2026-11-09'),
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  history.replaceState(null, '', '/habits');
});

afterEach(() => {
  setDigits('latn');
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

function serve(data: Parameters<typeof routeFetch>[1] = {}, options: Parameters<typeof routeFetch>[2] = {}): void {
  routeFetch(fetchMock, { habits: HABITS, today: todayOut(DUE), logs: LOGS, ...data }, options);
}

async function open(url = '/habits', data: Parameters<typeof routeFetch>[1] = {}) {
  history.replaceState(null, '', url);
  serve(data);
  const view = render(
    <LocationProvider>
      <HabitsPage />
    </LocationProvider>,
  );
  await screen.findByRole('radiogroup', { name: 'الحالة' });
  return view;
}

const row = (title: string): HTMLElement => screen.getByText(title).closest('li') as HTMLElement;
const chip = (name: string | RegExp): HTMLElement => within(screen.getByRole('radiogroup', { name: 'الحالة' })).getByRole('radio', { name });
const titles = (): string[] => Array.from(document.querySelectorAll('.habit-row .check-label')).map((el) => el.textContent ?? '');

describe('habits list: the status filter', () => {
  it('opens on «فعّالة» and lists the active habits alone', async () => {
    await open();
    expect(chip(/^فعّالة/).getAttribute('aria-checked')).toBe('true');
    expect(titles().sort()).toEqual(['إطفاء الشاشات', 'ترك السكر', 'شرب الماء', 'مشي أسبوعي'].sort());
  });

  it('every chip carries its count: «متأخرة 2»', async () => {
    await open();
    expect(chip('فعّالة 4')).toBeTruthy();
    expect(chip('منجزة 2')).toBeTruthy();
    expect(chip('متأخرة 2')).toBeTruthy();
    expect(chip('الكل 10')).toBeTruthy();
  });

  it('a chip writes the choice in ?status= and shows its rows', async () => {
    await open();
    fireEvent.click(chip(/^متأخرة/));
    await waitFor(() => expect(location.search).toContain('status=late'));
    expect(titles().sort()).toEqual(['الإنجليزية الأسبوعية', 'مراجعة الخطة'].sort());
    expect(chip(/^متأخرة/).getAttribute('aria-checked')).toBe('true');
  });

  it('reads the choice from ?status= when the page opens', async () => {
    await open('/habits?status=done');
    expect(chip(/^منجزة/).getAttribute('aria-checked')).toBe('true');
    expect(titles().sort()).toEqual(['المشي', 'تحدٍّ'].sort());
  });

  it('an unknown value falls back to «فعّالة»', async () => {
    await open('/habits?status=whatever');
    expect(chip(/^فعّالة/).getAttribute('aria-checked')).toBe('true');
  });

  it('writes the counts in the digits setting', async () => {
    setDigits('arab');
    await open();
    expect(chip('متأخرة ٢')).toBeTruthy();
  });
});

describe('habits list: what each row says', () => {
  it('«منجزة» holds a habit that reached its period and one whose time ended, with their own words', async () => {
    await open('/habits?status=done');
    expect(within(row('المشي')).getByText(/تحقق هدف الفترة/)).toBeTruthy();
    expect(within(row('تحدٍّ')).getByText('انتهت مدتها')).toBeTruthy();
  });

  it('«الكل» holds all six states: an upcoming habit says when it starts, an archived one says so', async () => {
    await open('/habits?status=all');
    expect(titles()).toHaveLength(10);
    expect(row('عادة قادمة').querySelector('.check-note')?.textContent).toBe('تبدأ في 2026-11-15');
    expect(within(row('عادة قديمة')).getByText('مؤرشفة')).toBeTruthy();
    expect(within(row('مراجعة الخطة')).getByText('متأخرة')).toBeTruthy();
  });

  it('upcoming and archived habits are in «الكل» only', async () => {
    for (const status of ['active', 'done', 'late']) {
      const view = await open(`/habits?status=${status}`);
      expect(screen.queryByText('عادة قادمة')).toBeNull();
      expect(screen.queryByText('عادة قديمة')).toBeNull();
      view.unmount();
    }
  });

  it('shows the identity sentence under the title when there is one', async () => {
    await open();
    expect(within(row('ترك السكر')).getByText('أنا شخص لا يحتاج السكر')).toBeTruthy();
    expect(within(row('شرب الماء')).queryByText('أنا شخص لا يحتاج السكر')).toBeNull();
  });

  it('shows the outcome badge and the progress of a weekly habit', async () => {
    await open();
    expect(within(row('شرب الماء')).getByText('O1')).toBeTruthy();
    expect(within(row('مشي أسبوعي')).getByText(/2 من 5 مرات هذا الأسبوع/)).toBeTruthy();
  });
});

describe('habits list: the three groups', () => {
  it('draws the three headings, with each habit under its anchor', async () => {
    await open();
    for (const title of ['بعد الاستيقاظ', 'خلال اليوم', 'قبل النوم']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    const wake = screen.getByRole('heading', { name: 'بعد الاستيقاظ' }).closest('section') as HTMLElement;
    expect(within(wake).getByText('شرب الماء')).toBeTruthy();
    const night = screen.getByRole('heading', { name: 'قبل النوم' }).closest('section') as HTMLElement;
    expect(within(night).getByText('إطفاء الشاشات')).toBeTruthy();
  });

  it('does not draw a group with no habit in the filter', async () => {
    await open('/habits?status=late');
    expect(screen.queryByRole('heading', { name: 'قبل النوم' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'بعد الاستيقاظ' })).toBeTruthy();
  });
});

describe('habits list: the abstain habit', () => {
  it('says «نظيف اليوم» and offers «تسجيل انزلاق» instead of a check mark', async () => {
    await open();
    const item = row('ترك السكر');
    expect(within(item).getByText('نظيف اليوم')).toBeTruthy();
    expect(within(item).getByRole('button', { name: /^تسجيل انزلاق/ })).toBeTruthy();
    expect(item.querySelector('[aria-pressed]')).toBeNull();
  });

  it('one tap queues one habit_logged done, and the row says «انزلاق مسجَّل اليوم»', async () => {
    await open();
    fireEvent.click(within(row('ترك السكر')).getByRole('button', { name: /^تسجيل انزلاق/ }));
    await within(row('ترك السكر')).findByText('انزلاق مسجَّل اليوم');
    const events = await listPending();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('habit_logged');
    expect(events[0]?.payload).toMatchObject({ habit_code: 'no_sugar', status: 'done' });
    expect(within(row('ترك السكر')).queryByRole('button', { name: /^تسجيل انزلاق/ })).toBeNull();
  });

  it('«تراجع» before the send discards the slip, and the row is «نظيف اليوم» again', async () => {
    await open();
    fireEvent.click(within(row('ترك السكر')).getByRole('button', { name: /^تسجيل انزلاق/ }));
    await within(row('ترك السكر')).findByText('انزلاق مسجَّل اليوم');
    fireEvent.click(screen.getByRole('button', { name: 'تراجع' }));
    await within(row('ترك السكر')).findByText('نظيف اليوم');
    expect(await listPending()).toHaveLength(0);
  });

  it('«تراجع» after the send says the log was sent and the skip corrects it', async () => {
    await open();
    fireEvent.click(within(row('ترك السكر')).getByRole('button', { name: /^تسجيل انزلاق/ }));
    await within(row('ترك السكر')).findByText('انزلاق مسجَّل اليوم');
    await clearOutbox(); // the flush took it
    fireEvent.click(screen.getByRole('button', { name: 'تراجع' }));
    await screen.findByText('أُرسل التسجيل؛ التصحيح بتخطي اليوم');
    expect(screen.queryByRole('button', { name: 'تراجع' })).toBeNull();
  });
});

describe('habits list: a log never makes the row vanish under the finger', () => {
  it('after a tick the row stays in «فعّالة» while the chips already count it done', async () => {
    await open();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('سُجّل: إطفاء الشاشات');
    await waitFor(() => expect(chip('فعّالة 3')).toBeTruthy());
    expect(chip('منجزة 3')).toBeTruthy();
    expect(titles()).toContain('إطفاء الشاشات');
  });

  it('the row leaves when the filter changes', async () => {
    await open();
    fireEvent.click(within(row('إطفاء الشاشات')).getByRole('button', { pressed: false }));
    await screen.findByText('سُجّل: إطفاء الشاشات');
    await waitFor(() => expect(chip('فعّالة 3')).toBeTruthy());
    fireEvent.click(chip(/^متأخرة/));
    await waitFor(() => expect(location.search).toContain('status=late'));
    fireEvent.click(chip(/^فعّالة/));
    await waitFor(() => expect(location.search).toContain('status=active'));
    expect(titles()).not.toContain('إطفاء الشاشات');
  });

  it('«تخطي» queues a skip', async () => {
    await open();
    fireEvent.click(within(row('شرب الماء')).getByRole('button', { name: /^تخطي/ }));
    await waitFor(async () => expect(await listPending()).toHaveLength(1));
    expect((await listPending())[0]?.payload).toMatchObject({ habit_code: 'wake_water', status: 'skip' });
  });
});

describe('habits list: the scope switch', () => {
  it('opens on «اليوم»: a habit not scheduled today is not listed', async () => {
    await open('/habits?status=all');
    expect(screen.getByRole('radio', { name: 'اليوم' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('يوم السبت')).toBeNull();
  });

  it('«الدورة» lists every live habit, and says the one not scheduled today is not scheduled', async () => {
    await open('/habits?status=all');
    fireEvent.click(screen.getByRole('radio', { name: 'الدورة' }));
    await waitFor(() => expect(location.search).toContain('scope=cycle'));
    // Saturday's habit was not logged last Saturday: it is late, though today is not its day.
    expect(chip('متأخرة 3')).toBeTruthy();
    expect(chip('الكل 11')).toBeTruthy();
    expect(within(row('يوم السبت')).getByText('غير مجدولة اليوم')).toBeTruthy();
    expect(within(row('يوم السبت')).queryByRole('button')).toBeNull();
  });

  it('«الأسبوع» lists the open weekly habits', async () => {
    await open();
    fireEvent.click(screen.getByRole('radio', { name: 'الأسبوع' }));
    await waitFor(() => expect(location.search).toContain('scope=week'));
    fireEvent.click(chip('الكل 5'));
    expect(titles().sort()).toEqual(['الإنجليزية الأسبوعية', 'تحدٍّ', 'عادة قادمة', 'عادة قديمة', 'مشي أسبوعي'].sort());
  });

  it('keeps the status when the scope changes, and the scope when the status changes', async () => {
    await open('/habits?status=late');
    fireEvent.click(screen.getByRole('radio', { name: 'الدورة' }));
    await waitFor(() => expect(location.search).toContain('scope=cycle'));
    expect(location.search).toContain('status=late');
    fireEvent.click(chip(/^فعّالة/));
    await waitFor(() => expect(location.search).toContain('status=active'));
    expect(location.search).toContain('scope=cycle');
  });
});

describe('habits list: the prominent button', () => {
  it('«عادة جديدة» is the one prominent button and leads to the editor', async () => {
    await open();
    const link = screen.getByRole('link', { name: 'عادة جديدة' });
    expect(link.getAttribute('href')).toBe('/habits/new');
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(link.classList.contains('btn-primary')).toBe(true);
  });

  it('the page has the heading «العادات»', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'العادات' })).toBeTruthy();
  });
});

describe('habits list: the four states come from the route', () => {
  it('loading: skeletons, busy, and the heading already there', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    render(
      <LocationProvider>
        <HabitsPage />
      </LocationProvider>,
    );
    expect(document.querySelector('.state-frame')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(2);
    expect(screen.getByRole('heading', { level: 1, name: 'العادات' })).toBeTruthy();
  });

  it('empty: no habit at all says what is missing and offers the action that fills it', async () => {
    serve({ habits: [], today: todayOut([]), logs: [] });
    render(
      <LocationProvider>
        <HabitsPage />
      </LocationProvider>,
    );
    await screen.findByText('لا عادات بعد.');
    const links = screen.getAllByRole('link', { name: 'عادة جديدة' });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/habits/new');
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('a filter with nothing in it says so, and keeps the chips', async () => {
    await open('/habits?status=late', { habits: [WALK], today: todayOut([WALK]), logs: LOGS });
    await screen.findByText('لا عادة متأخرة في هذا العرض.');
    expect(chip('متأخرة 0')).toBeTruthy();
  });

  it('error: «تعذّر التحميل» with a retry that reloads', async () => {
    serve({}, { fail: 500 });
    render(
      <LocationProvider>
        <HabitsPage />
      </LocationProvider>,
    );
    await screen.findByText('تعذّر التحميل');
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByRole('radiogroup', { name: 'الحالة' });
    expect(titles()).toContain('شرب الماء');
  });

  it('offline with a saved copy: the copy and «نسخة محفوظة · بلا اتصال»', async () => {
    const first = await open();
    await waitFor(async () => expect(await readCache(todayQueryKey(DAY))).toBeDefined());
    first.unmount();
    serve({}, { fail: 'network' });
    render(
      <LocationProvider>
        <HabitsPage />
      </LocationProvider>,
    );
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    expect(titles()).toContain('شرب الماء');
  });

  it('offline without a copy: «لا نسخة محفوظة بعد»', async () => {
    serve({}, { fail: 'network' });
    render(
      <LocationProvider>
        <HabitsPage />
      </LocationProvider>,
    );
    await screen.findByText('لا نسخة محفوظة بعد');
  });
});

describe('habits list: details', () => {
  it('does not load the push module or the habit detail page in this chunk', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../src/pages/habits/index.tsx'), 'utf8');
    expect(source).not.toMatch(/push\/subscribe/);
  });

  it('moves with the keyboard: the chips are one radio group with one tab stop', async () => {
    await open();
    const stops = screen.getAllByRole('radio').filter((r) => r.tabIndex === 0);
    // one in the scope switch, one in the status filter
    expect(stops).toHaveLength(2);
    await act(async () => undefined);
  });
});
