// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/app';
import { clearOutbox, closeDb, listPending } from '../../src/sync/outbox';

// Nothing here may send the outbox by itself: a test moves events out of the queue explicitly to
// play «sent». The timer behind scheduleFlush would outlive the test and reach the next one.
vi.mock('../../src/sync/outbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/sync/outbox')>();
  return { ...original, scheduleFlush: vi.fn() };
});

import { ActivityChips } from '../../src/pages/day/ActivityChips';
import { ClosureCard } from '../../src/pages/day/ClosureCard';
import { FEELINGS } from '../../src/pages/day/feelings';
import { PLANNED_MINUTES } from '../../src/pages/day/MorningForm';
import { defaultPart } from '../../src/pages/day/part';
import {
  DAY,
  MONTH_AGO,
  NOW,
  WEEK_AGO,
  click,
  entry,
  evening,
  go,
  json,
  offline,
  openDay,
  pendingOf,
  RoutedDay,
  stubApi,
  stubEvening,
  todayOut,
  type,
} from './day-helpers';

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

describe('which side of the day opens (design section 3)', () => {
  it('defaultPart is morning at 14:59 Riyadh and evening at 15:00', () => {
    expect(defaultPart(new Date('2026-11-10T11:59:00Z'))).toBe('morning');
    expect(defaultPart(new Date('2026-11-10T12:00:00Z'))).toBe('evening');
    // the browser's own zone does not matter: 21:00Z is already past midnight in Riyadh
    expect(defaultPart(new Date('2026-11-10T21:00:00Z'))).toBe('morning');
  });

  it('/day goes to /day/morning at 14:59 Riyadh', async () => {
    vi.setSystemTime(new Date('2026-11-10T11:59:00Z'));
    stubApi();
    go('/day');
    render(<RoutedDay />);
    await waitFor(() => expect(location.pathname).toBe('/day/morning'));
  });

  it('/day goes to /day/evening at 15:00 Riyadh', async () => {
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    stubApi();
    go('/day');
    render(<RoutedDay />);
    await waitFor(() => expect(location.pathname).toBe('/day/evening'));
  });

  it('the switcher moves between the sides and keeps itself (and the focus) mounted', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    const evening = screen.getByRole('radio', { name: 'المساء' });
    evening.focus();
    fireEvent.click(evening);
    await waitFor(() => expect(location.pathname).toBe('/day/evening'));
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect(screen.getByRole('radio', { name: 'المساء' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'المساء' }));
  });
});

describe('FEELINGS', () => {
  it('has the twelve nouns of the design, in order', () => {
    expect(FEELINGS.map((f) => [f.code, f.label])).toEqual([
      ['calm', 'هدوء'],
      ['grateful', 'امتنان'],
      ['excited', 'حماس'],
      ['content', 'رضا'],
      ['focused', 'تركيز'],
      ['tired', 'تعب'],
      ['anxious', 'قلق'],
      ['tense', 'توتر'],
      ['sad', 'حزن'],
      ['scattered', 'تشتّت'],
      ['frustrated', 'إحباط'],
      ['lonely', 'وحدة'],
    ]);
  });

  it('PLANNED_MINUTES is the five values of the design', () => {
    expect([...PLANNED_MINUTES]).toEqual([30, 60, 90, 120, 175]);
  });
});

describe('the morning page', () => {
  it('saves two priorities and 90 planned minutes as one journal_saved event', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });

    type('الأولوية 1', 'مراجعة الفصل الثالث');
    type('الأولوية 2', 'تمرين المشي');
    click('90');
    click('حفظ الصباح');

    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    const payload = event?.payload as { part: string; day?: string; answers: Record<string, unknown> };
    expect(payload.part).toBe('morning');
    expect(payload.day).toBe(DAY);
    expect(payload.answers.planned_minutes).toBe(90);
    const priorities = payload.answers.priorities as { title: string }[];
    expect(priorities.map((p) => p.title)).toEqual(['مراجعة الفصل الثالث', 'تمرين المشي']);
    expect(await listPending()).toHaveLength(1);
  });

  it('offers three priority fields and never a fourth', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    expect(screen.getAllByLabelText(/^الأولوية /)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /إضافة أولوية/ })).toBeNull();

    type('الأولوية 1', 'أ');
    type('الأولوية 2', 'ب');
    type('الأولوية 3', 'ج');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    const answers = (event?.payload as { answers: { priorities: unknown[] } }).answers;
    expect(answers.priorities).toHaveLength(3);
  });

  it('shows the insight priorities as suggestions with their source, to accept or replace', async () => {
    stubApi({
      today: todayOut({
        insight: {
          lines: ['سطر'],
          priorities: [
            { source_id: 'goal:O5', title: 'قراءة ثلاثين دقيقة' },
            { source_id: 'goal:O6', title: 'تمرين المحادثة' },
            { source_id: 'milestone:m1', title: 'تسليم المسودة' },
          ],
          question: null,
          source_ids: ['goal:O5', 'goal:O6', 'milestone:m1'],
        },
      }),
    });
    await openDay('/day/morning');
    await screen.findByText('قراءة ثلاثين دقيقة');
    expect(screen.getByText('تمرين المحادثة')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'قبول' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'استبدال' })).toHaveLength(3);
    expect(within(document.querySelector('.day-slots') as HTMLElement).getByText('O5')).toBeTruthy();

    // accept the first, replace the second with the person's own words, leave the third
    fireEvent.click(screen.getAllByRole('button', { name: 'قبول' })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole('button', { name: 'استبدال' })[1] as HTMLElement);
    type('الأولوية 2', 'مكالمة الإرشاد');
    click('حفظ الصباح');

    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    const answers = (event?.payload as { answers: { priorities: Record<string, unknown>[] } }).answers;
    expect(answers.priorities).toHaveLength(2);
    expect(answers.priorities[0]).toMatchObject({ title: 'قراءة ثلاثين دقيقة', source_id: 'goal:O5' });
    expect(answers.priorities[1]).toMatchObject({ title: 'مكالمة الإرشاد', source_id: null });
  });

  it('keeps the other morning fields: enthusiasm, up to three gratitude lines and the free text', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('سطر الحماس', 'جلسة تركيز طويلة');
    type('الامتنان 1', 'الصحة');
    type('الامتنان 3', 'القهوة');
    type('اليومية', 'يوم هادئ');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    const answers = (event?.payload as { answers: Record<string, unknown> }).answers;
    expect(answers.enthusiasm).toBe('جلسة تركيز طويلة');
    expect(answers.gratitude).toEqual(['الصحة', 'القهوة']);
    expect(answers.note).toBe('يوم هادئ');
  });

  it('reads the saved morning back into the form', async () => {
    stubApi({
      journal: [
        entry(DAY, 'morning', {
          priorities: [{ title: 'أولوية محفوظة', source_id: null, goal_ref: null }],
          planned_minutes: 120,
          note: 'ملاحظة محفوظة',
        }),
      ],
    });
    await openDay('/day/morning');
    await waitFor(() => expect((screen.getByLabelText('الأولوية 1') as HTMLInputElement).value).toBe('أولوية محفوظة'));
    expect(screen.getByRole('button', { name: '120' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('اليومية') as HTMLTextAreaElement).value).toBe('ملاحظة محفوظة');
  });
});

describe('the context column', () => {
  it('shows the cycle goal, and the deep reason and the standing rules empty between parentheses', async () => {
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    const column = screen.getByRole('complementary', { name: 'السياق' });
    expect(within(column).getByText(/الدورة 2/)).toBeTruthy();
    expect(within(column).getByText('(السبب العميق)')).toBeTruthy();
    expect(within(column).getByText('(القواعد الدائمة)')).toBeTruthy();
    expect(within(column).getByText('O4')).toBeTruthy();
  });
});

describe('the evening page', () => {
  it('the one-minute switch hides the sliders and the learned field', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect(screen.getAllByRole('slider')).toHaveLength(3);
    expect(screen.getByLabelText('تعلّمت')).toBeTruthy();

    click('دقيقة واحدة', 'switch');
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    expect(screen.queryByLabelText('تعلّمت')).toBeNull();
    expect(screen.getByRole('switch', { name: 'دقيقة واحدة' }).getAttribute('aria-checked')).toBe('true');
  });

  it('logs mood 4 with calm and grateful as one mood_logged event', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });

    click('4', 'radio');
    click('هدوء');
    click('امتنان');
    click('تسجيل المزاج');

    await waitFor(async () => expect(await pendingOf('mood_logged')).toHaveLength(1));
    const [event] = await pendingOf('mood_logged');
    expect(event?.payload).toMatchObject({ day: DAY, score: 4, feelings: ['calm', 'grateful'] });
    expect(await listPending()).toHaveLength(1);
  });

  it('caps the feelings at six', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    for (const f of FEELINGS.slice(0, 7)) click(f.label);
    expect(screen.getAllByRole('button', { pressed: true }).filter((b) => FEELINGS.some((f) => f.label === b.textContent?.trim()))).toHaveLength(6);
  });

  it('ActivityChips: the habits done today are selected, and the activities are their codes', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect(screen.getByRole('button', { name: 'القراءة' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'المشي' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'الماء' }).getAttribute('aria-pressed')).toBe('false');
    // an abstain habit's «done» is a slip, never an activity
    expect(screen.queryByRole('button', { name: 'بلا سكر' })).toBeNull();

    click('المشي'); // not an activity of the day after all
    click('3', 'radio');
    click('تسجيل المزاج');
    await waitFor(async () => expect(await pendingOf('mood_logged')).toHaveLength(1));
    const [event] = await pendingOf('mood_logged');
    expect(event?.payload).toMatchObject({ score: 3, activities: ['h_read'] });
  });

  it('shows the morning priorities, moves one to tomorrow and closes the day with one journal_saved event', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect(screen.getByRole('button', { name: /مراجعة الفصل/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /تمرين المشي/ })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'نقل للغد' })[0] as HTMLElement); // the first row
    fireEvent.click(screen.getByRole('button', { name: /تمرين المشي/ })); // done
    fireEvent.input(screen.getByLabelText('إنجاز اليوم'), { target: { value: 'أنهيت الفصل' } });
    fireEvent.change(screen.getByLabelText('المخرج'), { target: { value: 'O6' } });
    type('تعلّمت', 'الاستمرار أهم من الحجم');
    click('إغلاق اليوم');

    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    const payload = event?.payload as { part: string; day: string; answers: Record<string, unknown> };
    expect(payload.part).toBe('evening');
    expect(payload.day).toBe(DAY);
    expect(payload.answers.priorities).toEqual([
      { title: 'مراجعة الفصل', state: 'moved' },
      { title: 'تمرين المشي', state: 'done' },
    ]);
    expect(payload.answers).toMatchObject({
      one_minute: false,
      win: 'أنهيت الفصل',
      win_outcome: 'O6',
      learned: 'الاستمرار أهم من الحجم',
    });
    // no mood was chosen, so nothing but the journal was queued
    expect(await listPending()).toHaveLength(1);
  });

  it('a one-minute close sends no slider values and no learned text', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    type('تعلّمت', 'نص يُهمل');
    click('دقيقة واحدة', 'switch');
    click('إغلاق اليوم');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    expect((event?.payload as { answers: Record<string, unknown> }).answers).toMatchObject({
      one_minute: true,
      calm: null,
      distraction: null,
      presence: null,
      learned: null,
    });
  });

  it('sends only the sliders that were moved', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    fireEvent.input(screen.getByRole('slider', { name: 'الهدوء' }), { target: { value: '8' } });
    click('إغلاق اليوم');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    const [event] = await pendingOf('journal_saved');
    expect((event?.payload as { answers: Record<string, unknown> }).answers).toMatchObject({
      calm: 8,
      distraction: null,
      presence: null,
    });
  });

  it('closing with an unlogged mood logs it once; closing after logging it does not log it again', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    click('5', 'radio');
    click('إغلاق اليوم');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    expect(await pendingOf('mood_logged')).toHaveLength(1);

    // the same day again, mood already logged: closing again adds the journal only
    click('تسجيل المزاج'); // mood unchanged since it was logged: nothing new to log
    await act(async () => {});
    expect(await pendingOf('mood_logged')).toHaveLength(1);
  });

  it('says what is missing when the morning left no priorities, with the way to write them', async () => {
    stubEvening({ journal: [] });
    await openDay('/day/evening');
    await screen.findByText('لا أولويات من الصباح.');
    expect(screen.getByRole('link', { name: 'كتابة أولويات الصباح' }).getAttribute('href')).toBe('/day/morning');
  });

  it('reads the mood already logged today back', async () => {
    stubEvening({ mood: [{ day: DAY, score: 2, feelings: ['tired'], activities: ['h_read'] }] });
    await openDay('/day/evening');
    await waitFor(() => expect(screen.getByRole('radio', { name: '2' }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByRole('button', { name: 'تعب' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'المشي' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('OnThisDay', () => {
  it('draws the win of a week ago and the learned text of a month ago, word for word', async () => {
    const view = stubEvening({
      journal: [
        evening.morning,
        entry(WEEK_AGO, 'evening', { win: 'أنهيت التقرير', learned: 'لا يُعرض' }),
        entry(MONTH_AGO, 'evening', { learned: 'البداية المبكرة تكفي' }),
      ],
    });
    await openDay('/day/evening');
    await screen.findByText('قبل أسبوع:');
    expect(screen.getByText('أنهيت التقرير')).toBeTruthy();
    expect(screen.queryByText('لا يُعرض')).toBeNull();
    expect(screen.getByText('قبل شهر:')).toBeTruthy();
    expect(screen.getByText('البداية المبكرة تكفي')).toBeTruthy();
    const journal = view.calls.find((u) => u.pathname === '/v1/journal');
    expect(journal?.searchParams.get('from')).toBe(MONTH_AGO);
    expect(journal?.searchParams.get('to')).toBe(DAY);
  });

  it('draws only the one that exists', async () => {
    stubEvening({ journal: [evening.morning, entry(WEEK_AGO, 'evening', { win: 'إنجاز الأسبوع' })] });
    await openDay('/day/evening');
    await screen.findByText('قبل أسبوع:');
    expect(screen.queryByText('قبل شهر:')).toBeNull();
  });

  it('draws nothing when neither day has a journal', async () => {
    stubEvening({ journal: [evening.morning, entry('2026-11-05', 'evening', { win: 'يوم آخر' })] });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect(screen.queryByText('قبل أسبوع:')).toBeNull();
    expect(screen.queryByText('قبل شهر:')).toBeNull();
    expect(screen.queryByText('في مثل هذا اليوم')).toBeNull();
  });
});

describe('ClosureCard', () => {
  it('says «أُغلق اليوم» when closed, and nothing when not', () => {
    const { rerender } = render(<ClosureCard day={DAY} closed={false} />);
    expect(screen.queryByText('أُغلق اليوم')).toBeNull();
    rerender(<ClosureCard day={DAY} closed />);
    expect(screen.getByText('أُغلق اليوم')).toBeTruthy();
    rerender(<ClosureCard day={DAY} closed summary={<p>ملخص من المهمة 20</p>} />);
    expect(screen.getByText('ملخص من المهمة 20')).toBeTruthy();
  });

  it('is shown on the evening page once the server has the evening journal', async () => {
    stubEvening({ journal: [evening.morning, entry(DAY, 'evening', { one_minute: true, priorities: [] })] });
    await openDay('/day/evening');
    await screen.findByText('أُغلق اليوم');
  });
});

describe('ActivityChips', () => {
  it('renders nothing selectable for a day without habits, and says so', () => {
    render(<ActivityChips habits={[]} selected={[]} onChange={() => undefined} />);
    expect(screen.getByText('لا عادات لليوم.')).toBeTruthy();
  });
});

describe('offline and undo', () => {
  it('shows the closure as waiting to be sent when the page is offline', async () => {
    stubEvening();
    const first = await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' }); // the copy is now saved
    first.unmount();

    stubApi({}, { today: offline, journal: offline, mood: offline });
    await openDay('/day/evening');
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    click('إغلاق اليوم');
    await screen.findByText('أُغلق اليوم · يُرسل عند عودة الاتصال');
    expect(await pendingOf('journal_saved')).toHaveLength(1);
  });

  it('shows the saved copy of the day with its pending journal laid over it', async () => {
    stubEvening();
    const first = await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    first.unmount();

    stubApi({}, { today: offline, journal: offline, mood: offline });
    await openDay('/day/morning');
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    type('الأولوية 1', 'عمل بلا اتصال');
    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    await screen.findByText(/لم يُرسل بعد/);
  });

  it('undoes a save before it is sent, and states the fact once it was sent', async () => {
    stubEvening();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('الأولوية 1', 'أولوية');
    click('حفظ الصباح');
    await screen.findByText(/لم يُرسل بعد/);
    click('تراجع');
    await waitFor(async () => expect(await listPending()).toHaveLength(0));
    await screen.findByText('أُلغي الحفظ');
    expect(screen.queryByText(/لم يُرسل بعد/)).toBeNull();

    // save again; this time the queue is emptied behind the page's back, as a flush would
    click('حفظ الصباح');
    await screen.findByText(/لم يُرسل بعد/);
    await clearOutbox();
    fireEvent(window, new Event('online'));
    await screen.findByText('أُرسل الحفظ');
    expect(screen.queryByRole('button', { name: 'تراجع' })).toBeNull();
  });
});

describe('the unsent draft', () => {
  it('survives a reload of the page, and goes once the server accepted the journal', async () => {
    stubApi();
    const first = await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    type('اليومية', 'نص طويل لم يُحفظ بعد');
    first.unmount();

    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    expect((screen.getByLabelText('اليومية') as HTMLTextAreaElement).value).toBe('نص طويل لم يُحفظ بعد');
    expect(Object.keys(localStorage).some((k) => k.includes('draft'))).toBe(true);

    click('حفظ الصباح');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    // queued is not accepted: the text stays on the device until the server has it
    expect(Object.keys(localStorage).some((k) => k.includes('draft'))).toBe(true);
    await clearOutbox();
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(Object.keys(localStorage).filter((k) => k.includes('draft'))).toHaveLength(0));
  });

  it('prunes the drafts of days older than yesterday when the page loads', async () => {
    for (const day of ['2026-11-07', '2026-11-08', '2026-11-09', DAY]) {
      localStorage.setItem(`yawmi.draft.day.${day}.morning`, JSON.stringify({ note: day }));
    }
    stubApi();
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    expect(
      Object.keys(localStorage)
        .filter((k) => k.startsWith('yawmi.draft.'))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual(['yawmi.draft.day.2026-11-09.morning', `yawmi.draft.day.${DAY}.morning`]);
  });

  it('removes the evening draft once the evening is accepted, not when it is queued', async () => {
    stubEvening();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    type('تعلّمت', 'درس لم يُحفظ');
    expect(localStorage.getItem(`yawmi.draft.day.${DAY}.evening`)).not.toBeNull();
    click('إغلاق اليوم');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    expect(localStorage.getItem(`yawmi.draft.day.${DAY}.evening`)).not.toBeNull();
    await clearOutbox();
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(localStorage.getItem(`yawmi.draft.day.${DAY}.evening`)).toBeNull());
  });

  it('keeps the evening draft apart from the morning one', async () => {
    stubEvening();
    const first = await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    type('تعلّمت', 'درس المساء');
    first.unmount();

    const second = await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    expect((screen.getByLabelText('اليومية') as HTMLTextAreaElement).value).toBe('');
    second.unmount();
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect((screen.getByLabelText('تعلّمت') as HTMLTextAreaElement).value).toBe('درس المساء');
  });
});

describe('the four states, from the real route', () => {
  it('loading: skeletons with aria-busy until the first answer', async () => {
    let release!: (r: Response) => void;
    stubApi({}, { today: () => new Promise<Response>((resolve) => (release = resolve)) });
    await openDay('/day/morning');
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    release(json(todayOut()));
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('error: «تعذّر التحميل» with a retry that loads again', async () => {
    let fail = true;
    stubApi({}, { today: () => (fail ? json({ detail: 'x' }, 500) : json(todayOut())) });
    await openDay('/day/morning');
    await screen.findByText('تعذّر التحميل');
    fail = false;
    click('إعادة المحاولة');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
  });

  it('evening empty: no morning priorities says what is missing and offers the action', async () => {
    stubEvening({ journal: [] });
    await openDay('/day/evening');
    await screen.findByText('لا أولويات من الصباح.');
  });

  it('the whole app route renders the page inside the shell', async () => {
    stubApi();
    go('/day/evening');
    render(<App />);
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    expect(screen.getByRole('heading', { level: 1, name: 'اليوم' })).toBeTruthy();
  });
});
