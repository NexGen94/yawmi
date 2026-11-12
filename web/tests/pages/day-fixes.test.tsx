// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fmt } from '../../src/lib/format';
import { clearOutbox, closeDb, listPending, openDb } from '../../src/sync/outbox';
import {
  click,
  DAY,
  evening,
  habit,
  json,
  NOW,
  offline,
  openDay,
  pendingOf,
  stubApi,
  stubEvening,
  todayOut,
  type,
} from './day-helpers';

// The timer behind scheduleFlush would outlive a test: a test plays «sent» and «refused» itself.
vi.mock('../../src/sync/outbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/sync/outbox')>();
  return { ...original, scheduleFlush: vi.fn() };
});

// 23:59 in Riyadh on 2026-11-10, and half a minute after its midnight.
const LATE = '2026-11-10T20:59:00Z';
const AFTER_MIDNIGHT = '2026-11-10T21:00:30Z';
const NEXT_DAY = '2026-11-11';
const NEXT_MORNING = '2026-11-11T09:00:00Z';

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const draftKeys = (): string[] => Object.keys(localStorage).filter((k) => k.startsWith('yawmi.draft.'));
const dateLine = (): string => document.querySelector('.day-date')?.textContent ?? '';

/** The queue changed behind the page's back, as a flush does: it looks again on `online`. */
async function queueMoved(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });
}

/** The server accepted everything that was queued. */
async function accepted(): Promise<void> {
  await clearOutbox();
  await queueMoved();
}

/** The server refused the given events (a 422): the outbox moves them to quarantine. */
async function refused(ids: string[], errors: { loc: (string | number)[]; type: string; msg: string }[]): Promise<void> {
  const db = await openDb();
  const events = (await db.getAll('outbox')).filter((e) => ids.includes(e.id));
  const tx = db.transaction(['outbox', 'quarantine'], 'readwrite');
  for (const event of events) {
    void tx.objectStore('quarantine').put({ ...event, errors, quarantined_at: new Date().toISOString() });
    void tx.objectStore('outbox').delete(event.id);
  }
  await tx.done;
  await queueMoved();
}

const TOO_LONG_NOTE = [{ loc: ['body', 'events', 0, 'payload', 'answers', 'note'], type: 'string_too_long', msg: 'too long' }];

/** The clock moves past Riyadh midnight and the page is told, as it is when the tab wakes up. */
async function crossMidnight(to = AFTER_MIDNIGHT): Promise<void> {
  vi.setSystemTime(new Date(to));
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('free text has the limits of the server (I-1, M-1)', () => {
  it('every morning field carries its limit', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    const max = (label: string): string | null => screen.getByLabelText(label).getAttribute('maxlength');
    expect(max('الأولوية 1')).toBe('120');
    expect(max('سطر الحماس')).toBe('200');
    expect(max('الامتنان 1')).toBe('200');
    expect(max('الامتنان 3')).toBe('200');
    expect(max('اليومية')).toBe('2000');
  });

  it('every evening field carries its limit', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    const max = (label: string): string | null => screen.getByLabelText(label).getAttribute('maxlength');
    expect(max('إنجاز اليوم')).toBe('300');
    expect(max('تعلّمت')).toBe('300');
    expect(max('الامتنان 2')).toBe('200');
    expect(max('اليومية')).toBe('2000');
  });

  it('a note over 2000 characters is cut at 2000 and saved at 2000, not refused', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('اليومية', 'ا'.repeat(2500));
    expect((screen.getByLabelText('اليومية') as HTMLTextAreaElement).value).toHaveLength(2000);
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    expect((event?.payload as { answers: { note: string } }).answers.note).toHaveLength(2000);
  });

  it('the count shows near the limit and not before', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    type('تعلّمت', 'ا'.repeat(100));
    expect(document.querySelector('.field-count')).toBeNull();
    type('تعلّمت', 'ا'.repeat(280));
    expect(document.querySelector('.field-count')?.textContent).toMatch(/280\s*\/\s*300/);
  });

  it('feelings and activities show their cap when they reach it', async () => {
    const many = Array.from({ length: 14 }, (_, i) => habit(`h${i}`, `عادة ${i + 1}`, { done_today: true, status_today: 'done' }));
    stubApi({ today: todayOut({ habits_due: many }), journal: [evening.morning] });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    // 14 done habits: only 12 are chosen, and the page says why
    expect(screen.getAllByRole('button', { pressed: true }).filter((b) => /^عادة \d+$/.test(b.textContent?.trim() ?? ''))).toHaveLength(12);
    expect(screen.getByText('حتى 12 نشاطاً')).toBeTruthy();
    click('عادة 13'); // not chosen, cannot be added
    expect(screen.getByRole('button', { name: 'عادة 13' }).getAttribute('aria-pressed')).toBe('false');

    for (const label of ['هدوء', 'امتنان', 'حماس', 'رضا', 'تركيز', 'تعب']) click(label);
    expect(screen.getByText('حتى 6 مشاعر')).toBeTruthy();
    click('قلق');
    expect(screen.getByRole('button', { name: 'قلق' }).getAttribute('aria-pressed')).toBe('false');

    click('4', 'radio');
    click('تسجيل المزاج');
    await waitFor(async () => expect(await pendingOf('mood_logged')).toHaveLength(1));
    const [event] = await pendingOf('mood_logged');
    const payload = event?.payload as { activities: string[]; feelings: string[] };
    expect(payload.activities).toHaveLength(12);
    expect(payload.feelings).toHaveLength(6);
  });
});

describe('the draft waits for the server (I-1)', () => {
  it('is kept after the save is queued and removed once the server accepted it', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('اليومية', 'نص مهم');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    expect(localStorage.getItem(`yawmi.draft.day.${DAY}.morning`)).not.toBeNull();

    await accepted();
    await waitFor(() => expect(draftKeys()).toEqual([]));
  });

  it('editing after a save makes it an unsaved draft again', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('اليومية', 'نص أول');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    type('اليومية', 'نص أول وزيادة');
    await accepted(); // the first save was accepted; the addition was not saved
    expect(JSON.parse(localStorage.getItem(`yawmi.draft.day.${DAY}.morning`) ?? '{}').note).toBe('نص أول وزيادة');
  });
});

describe('a refused save is not «sent» (I-2)', () => {
  it('says it was refused, with the reason, and keeps the text and the draft', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('اليومية', 'نص طويل');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');

    await refused([event?.id ?? ''], TOO_LONG_NOTE);
    await screen.findByText(/تعذّر الحفظ/);
    expect(screen.getByRole('alert').textContent).toContain('اليومية');
    expect(screen.queryByText('أُرسل الحفظ')).toBeNull();
    expect(screen.queryByText(/لم يُرسل بعد/)).toBeNull();
    expect((screen.getByLabelText('اليومية') as HTMLTextAreaElement).value).toBe('نص طويل');
    expect(localStorage.getItem(`yawmi.draft.day.${DAY}.morning`)).not.toBeNull();
  });

  it('restores the text from the kept draft when the form is opened again', async () => {
    stubApi();
    const first = await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('اليومية', 'نص يعود');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    await refused([event?.id ?? ''], TOO_LONG_NOTE);
    first.unmount();

    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    expect((screen.getByLabelText('اليومية') as HTMLTextAreaElement).value).toBe('نص يعود');
  });

  it('offers a retry that puts the event back in the queue', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('اليومية', 'نص');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    await refused([event?.id ?? ''], TOO_LONG_NOTE);
    await screen.findByText(/تعذّر الحفظ/);

    click('إعادة المحاولة');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    await screen.findByText(/لم يُرسل بعد/);
    expect(screen.queryByText(/تعذّر الحفظ/)).toBeNull();
  });

  it('a refused mood makes «تسجيل المزاج» available again', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    click('4', 'radio');
    click('تسجيل المزاج');
    await waitFor(async () => expect(await pendingOf('mood_logged')).toHaveLength(1));
    expect((screen.getByRole('button', { name: 'تسجيل المزاج' }) as HTMLButtonElement).disabled).toBe(true);
    const [event] = await pendingOf('mood_logged');
    await refused([event?.id ?? ''], [{ loc: ['body', 'events', 0, 'payload', 'activities'], type: 'too_long', msg: '' }]);
    await screen.findByText(/تعذّر الحفظ/);
    await waitFor(() => expect((screen.getByRole('button', { name: 'تسجيل المزاج' }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('midnight (I-3)', () => {
  it('moves to the new day when nothing is unsaved: the date and the three queries, with no reload', async () => {
    vi.setSystemTime(new Date(LATE));
    const api = stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(dateLine()).toContain(fmt.day(DAY));
    const before = (path: string): number => api.calls.filter((u) => u.pathname === path).length;
    const counts = [before('/v1/today'), before('/v1/journal'), before('/v1/mood')];

    await crossMidnight();
    await waitFor(() => expect(dateLine()).toContain(fmt.day(NEXT_DAY)));
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect(before('/v1/today')).toBeGreaterThan(counts[0] ?? 0);
    expect(before('/v1/journal')).toBeGreaterThan(counts[1] ?? 0);
    expect(before('/v1/mood')).toBeGreaterThan(counts[2] ?? 0);
    const journal = api.calls.filter((u) => u.pathname === '/v1/journal').at(-1);
    expect(journal?.searchParams.get('to')).toBe(NEXT_DAY);
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading);
    expect(screen.queryByText('نص يوم أمس لم يُحفظ بعد')).toBeNull();
  });

  it('a journal queued at 23:59 keeps its own day, and does not close the new one', async () => {
    vi.setSystemTime(new Date(LATE));
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    click('إغلاق اليوم');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    await screen.findByText(/أُغلق اليوم · /);

    await crossMidnight();
    await waitFor(() => expect(dateLine()).toContain(fmt.day(NEXT_DAY)));
    const [event] = await pendingOf('journal_saved');
    expect((event?.payload as { day: string }).day).toBe(DAY);
    expect(screen.queryByText(/أُغلق اليوم · /)).toBeNull();
    expect(screen.queryByText('أُغلق اليوم')).toBeNull();
  });

  it('keeps yesterday on screen when it holds unsaved text, and saves it for yesterday', async () => {
    vi.setSystemTime(new Date(LATE));
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    type('تعلّمت', 'مساء طويل قبل منتصف الليل');

    await crossMidnight();
    await screen.findByText('نص يوم أمس لم يُحفظ بعد');
    expect(dateLine()).toContain(fmt.day(DAY));
    expect((screen.getByLabelText('تعلّمت') as HTMLTextAreaElement).value).toBe('مساء طويل قبل منتصف الليل');

    click('حفظه ليوم أمس');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    const payload = event?.payload as { day: string; part: string; answers: { learned: string } };
    expect(payload).toMatchObject({ day: DAY, part: 'evening' });
    expect(payload.answers.learned).toBe('مساء طويل قبل منتصف الليل');
    await waitFor(() => expect(dateLine()).toContain(fmt.day(NEXT_DAY)));
    expect(screen.queryByText('نص يوم أمس لم يُحفظ بعد')).toBeNull();
    expect((screen.getByLabelText('تعلّمت') as HTMLTextAreaElement).value).toBe('');
  });

  it('«الانتقال إلى اليوم» leaves the draft reachable on the new day, to open or to discard', async () => {
    vi.setSystemTime(new Date(LATE));
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    type('تعلّمت', 'نص لم يُحفظ');
    await crossMidnight();
    await screen.findByText('نص يوم أمس لم يُحفظ بعد');

    click('الانتقال إلى اليوم');
    await waitFor(() => expect(dateLine()).toContain(fmt.day(NEXT_DAY)));
    expect((screen.getByLabelText('تعلّمت') as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem(`yawmi.draft.day.${DAY}.evening`)).not.toBeNull();
    await screen.findByText('نص يوم أمس لم يُحفظ بعد'); // the notice on the new day
    expect(screen.getByRole('button', { name: 'فتحه' })).toBeTruthy();

    click('فتحه');
    await waitFor(() => expect(dateLine()).toContain(fmt.day(DAY)));
    expect((screen.getByLabelText('تعلّمت') as HTMLTextAreaElement).value).toBe('نص لم يُحفظ');

    click('الانتقال إلى اليوم');
    await waitFor(() => expect(dateLine()).toContain(fmt.day(NEXT_DAY)));
    click('حذفه');
    await waitFor(() => expect(draftKeys()).toEqual([]));
    expect(screen.queryByText('نص يوم أمس لم يُحفظ بعد')).toBeNull();
  });

  it.each(['America/New_York', 'Pacific/Auckland'])('follows Riyadh midnight under the browser zone %s', async (zone) => {
    const was = process.env.TZ;
    process.env.TZ = zone;
    try {
      vi.setSystemTime(new Date(LATE));
      stubEvening();
      await openDay('/day/evening');
      await screen.findByRole('button', { name: 'إغلاق اليوم' });
      expect(dateLine()).toContain(fmt.day(DAY));
      await crossMidnight();
      await waitFor(() => expect(dateLine()).toContain(fmt.day(NEXT_DAY)));
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  });
});

describe('offline on a new day still lets the day be logged (I-4)', () => {
  it('shows the forms from the last copy, with today\'s date and none of yesterday\'s done marks', async () => {
    stubEvening();
    const first = await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    first.unmount();

    vi.setSystemTime(new Date(NEXT_MORNING));
    stubApi({}, { today: offline, journal: offline, mood: offline });
    await openDay('/day/evening');
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    expect(dateLine()).toContain(fmt.day(NEXT_DAY));
    expect(screen.getByRole('button', { name: 'القراءة' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'الماء' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'السياق' })).toBeNull();

    click('4', 'radio');
    click('إغلاق اليوم');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    expect((event?.payload as { day: string }).day).toBe(NEXT_DAY);
    expect(await pendingOf('mood_logged')).toHaveLength(1);
  });

  it('with no copy at all: the morning form shows and says so', async () => {
    stubApi({}, { today: offline, journal: offline, mood: offline });
    await openDay('/day/morning');
    await screen.findByText('لا نسخة محفوظة بعد · التسجيل يعمل ويُرسل عند عودة الاتصال');
    type('الأولوية 1', 'عمل بلا اتصال');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    expect(screen.queryByText('لا نسخة محفوظة بعد')).toBeNull();
  });

  it('with no copy at all: the evening forms show and the habits section says it waits for the connection', async () => {
    stubApi({}, { today: offline, journal: offline, mood: offline });
    await openDay('/day/evening');
    await screen.findByText('لا نسخة محفوظة بعد · التسجيل يعمل ويُرسل عند عودة الاتصال');
    expect(screen.getByText('قائمة العادات تظهر عند الاتصال')).toBeTruthy();
    click('3', 'radio');
    click('إغلاق اليوم');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [mood] = await pendingOf('mood_logged');
    expect(mood?.payload).toMatchObject({ day: DAY, score: 3, activities: [] });
  });
});

describe('small things (M-3, M-4, M-5, M-6)', () => {
  it('a double click on «حفظ الصباح» queues one event', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('اليومية', 'نص');
    // two clicks before the page can draw «busy» (no act in between): the guard is not the disabled look
    const button = screen.getByRole('button', { name: 'حفظ الصباح' }) as HTMLButtonElement;
    button.click();
    button.click();
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(await listPending()).toHaveLength(1);
  });

  it('a double click on «إغلاق اليوم» queues one journal and one mood', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    click('5', 'radio');
    const button = screen.getByRole('button', { name: 'إغلاق اليوم' }) as HTMLButtonElement;
    button.click();
    button.click();
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(await pendingOf('journal_saved')).toHaveLength(1);
    expect(await pendingOf('mood_logged')).toHaveLength(1);
  });

  it('the one-minute hint lists exactly what the switch hides', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByText('يُخفي منزلقات الحالة وحقل «تعلّمت»');
    click('دقيقة واحدة', 'switch');
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    expect(screen.queryByLabelText('تعلّمت')).toBeNull();
    // and nothing else goes: gratitude, on-this-day's place and the free text stay
    expect(screen.getByLabelText('الامتنان 1')).toBeTruthy();
    expect(screen.getByLabelText('اليومية')).toBeTruthy();
  });

  it('suggestions name their source in Arabic, and hide one that cannot be named', async () => {
    stubApi({
      today: todayOut({
        habits_due: [habit('h_read', 'القراءة')],
        insight: {
          lines: [],
          question: null,
          source_ids: [],
          priorities: [
            { source_id: 'goal:O5', title: 'مراجعة المفردات' },
            { source_id: 'milestone:m12', title: 'تسليم المسودة' },
            { source_id: 'zzz:internal', title: 'بند بلا مصدر معروف' },
          ],
        },
      }),
    });
    await openDay('/day/morning');
    await screen.findByText('مراجعة المفردات');
    const slots = within(document.querySelector('.day-slots') as HTMLElement);
    expect(slots.getByText('هدف')).toBeTruthy();
    expect(slots.getByText('O5')).toBeTruthy();
    expect(slots.getByText('محطة')).toBeTruthy();
    expect(slots.getByText('m12')).toBeTruthy();
    expect(screen.queryByText('goal:O5')).toBeNull();
    expect(screen.queryByText('zzz:internal')).toBeNull();
    expect(screen.getByText('بند بلا مصدر معروف')).toBeTruthy();
  });

  it('the save line belongs to its side: it is not shown under the other one', async () => {
    stubEvening();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('الأولوية 1', 'أ');
    click('حفظ الصباح');
    await screen.findByText(/لم يُرسل بعد/);

    fireEvent.click(screen.getByRole('radio', { name: 'المساء' }));
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect(screen.queryByText(/لم يُرسل بعد/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'الصباح' }));
    await screen.findByText(/لم يُرسل بعد/);
  });
});

describe.each([
  ['morning', 'حفظ الصباح', '/day/morning'],
  ['evening', 'إغلاق اليوم', '/day/evening'],
] as const)('the four states, %s', (_part, action, path) => {
  it('loading: skeletons with aria-busy, then the form', async () => {
    let release!: (r: Response) => void;
    stubApi({ journal: [evening.morning] }, { today: () => new Promise<Response>((resolve) => (release = resolve)) });
    await openDay(path);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: action })).toBeNull();
    release(json(todayOut()));
    await screen.findByRole('button', { name: action });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('error: «تعذّر التحميل» and a retry that loads', async () => {
    let fail = true;
    stubApi({ journal: [evening.morning] }, { today: () => (fail ? json({ detail: 'x' }, 500) : json(todayOut())) });
    await openDay(path);
    await screen.findByText('تعذّر التحميل');
    expect(screen.queryByRole('button', { name: action })).toBeNull();
    fail = false;
    click('إعادة المحاولة');
    await screen.findByRole('button', { name: action });
  });

  it('offline with a saved copy: the badge and the form', async () => {
    stubEvening();
    const first = await openDay(path);
    await screen.findByRole('button', { name: action });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    first.unmount();
    stubApi({}, { today: offline, journal: offline, mood: offline });
    await openDay(path);
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    expect(screen.getByRole('button', { name: action })).toBeTruthy();
  });

  it('offline without a copy: the form, and the line that says so', async () => {
    stubApi({}, { today: offline, journal: offline, mood: offline });
    await openDay(path);
    await screen.findByText('لا نسخة محفوظة بعد · التسجيل يعمل ويُرسل عند عودة الاتصال');
    expect(screen.getByRole('button', { name: action })).toBeTruthy();
  });

  it('empty: nothing saved and nothing proposed gives a blank form', async () => {
    stubApi();
    await openDay(path);
    await screen.findByRole('button', { name: action });
    if (path === '/day/morning') {
      expect((screen.getByLabelText('الأولوية 1') as HTMLInputElement).value).toBe('');
      expect(screen.queryByRole('button', { name: 'قبول' })).toBeNull();
    } else {
      expect(screen.getByText('لا أولويات من الصباح.')).toBeTruthy();
    }
  });
});
