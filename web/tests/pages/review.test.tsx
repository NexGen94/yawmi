// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/app';
import { setDigits } from '../../src/lib/format';
import { closeDb, enqueue } from '../../src/sync/outbox';
import { card, coded, consent, consentRequired, insightOut, json, settings, stubServer, type Handler } from '../helpers/ai-fixtures';
import { goals, milestone } from '../helpers/goals-fixtures';
import { habit, type HabitLogOut, type JournalEntryOut } from '../helpers/today-fixtures';

// The review page (task 21, design 4): the week tab with its four numbers and three lists and the
// weekly insight, the journal tab with its timeline and month cards, and the mood tab with the year
// grid. Saturday 2026-11-14 noon in Riyadh; the week runs Sunday 8 to Saturday 14.

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

const NOW = '2026-11-14T09:00:00Z';
const WEEK_START = '2026-11-08';

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  localStorage.clear();
  history.replaceState(null, '', '/review');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  setDigits('latn');
});

afterEach(() => {
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- the week of the story ----------

const log = (habit_code: string, day: string, value: number | null = null, status = 'done'): HabitLogOut => ({ habit_code, day, value, status });
const DAYS = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];

const ENGLISH = habit('english_minutes', 'دقائق الإنجليزية', {
  ac_ref: 'AC7.4',
  kind: 'duration',
  unit: 'min',
  period: 'week',
  target_per_period: 285,
});
const MEDITATION = habit('meditation', 'جلسة تأمّل', { ac_ref: 'AC2.7', period: 'week', target_per_period: 5 });
const WALK = habit('walk', 'المشي');
const MISSED = habit('evening_read', 'قراءة المساء');
const QUIET = habit('no_late_screen', 'بلا شاشة متأخرة', { polarity: 'abstain' });
const HABITS = [ENGLISH, MEDITATION, WALK, MISSED, QUIET];

const LOGS: HabitLogOut[] = [
  log('english_minutes', '2026-11-09', 40),
  log('english_minutes', '2026-11-10', 45),
  log('meditation', '2026-11-09'),
  log('meditation', '2026-11-10'),
  ...DAYS.map((d) => log('walk', d)),
];

const entry = (day: string, part: 'morning' | 'evening', answers: Record<string, unknown> = {}): JournalEntryOut => ({
  day,
  part,
  answers,
  logged_at: `${day}T${part === 'morning' ? '04' : '17'}:00:00Z`,
});

/** Morning journals on four days of the week and evening journals on five. */
const WEEK_JOURNAL: JournalEntryOut[] = [
  ...DAYS.slice(0, 4).map((d) => entry(d, 'morning')),
  ...DAYS.slice(1, 6).map((d) => entry(d, 'evening')),
];

const GOALS = goals({
  milestones: [
    milestone('late', 'مراجعة الميزانية', { due_date: '2026-11-08' }),
    milestone('soon', 'حجز دورة الإنجليزية', { due_date: '2026-11-20' }),
    milestone('far', 'تحديث السيرة', { due_date: '2027-03-01' }),
  ],
});

const weekly = (over: Partial<ReturnType<typeof insightOut>> = {}) =>
  insightOut({ kind: 'weekly', day: WEEK_START, lines: ['الموضوع المتكرر: ضغط العمل مساءً.', 'المساء أقل من الصباح.'], ...over });

function serve(over: Record<string, Handler> = {}) {
  return stubServer({
    'GET /v1/settings': () => json(settings()),
    'GET /v1/habits': () => json(HABITS),
    'GET /v1/habit-logs': () => json({ logs: LOGS }),
    'GET /v1/journal': () => json({ entries: WEEK_JOURNAL }),
    'GET /v1/mood': () => json({ logs: [] }),
    'GET /v1/reviews': () => json({ items: [] }),
    'GET /v1/goals': () => json(GOALS),
    'GET /v1/ai/consent': () => json(consent({ granted: true })),
    'POST /v1/insights/weekly': () => json(weekly()),
    ...over,
  });
}

async function openReview(url = '/review'): Promise<void> {
  history.replaceState(null, '', url);
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'المراجعة' });
}

async function openWeek(): Promise<HTMLElement> {
  await openReview();
  return (await screen.findByRole('list', { name: 'أرقام الأسبوع' })) as HTMLElement;
}

const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

describe('the review page: the tabs', () => {
  it('has the three tabs, the week first, and writes the chosen tab in ?tab=', async () => {
    serve();
    await openReview();
    const tabs = screen.getByRole('radiogroup', { name: 'القسم' });
    expect(within(tabs).getAllByRole('radio').map((r) => r.textContent)).toEqual(['الأسبوع', 'السجل', 'المزاج']);
    expect(within(tabs).getByRole('radio', { name: 'الأسبوع' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(tabs).getByRole('radio', { name: 'السجل' }));
    await waitFor(() => expect(location.search).toBe('?tab=journal'));
    expect(within(tabs).getByRole('radio', { name: 'السجل' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(tabs).getByRole('radio', { name: 'المزاج' }));
    await waitFor(() => expect(location.search).toBe('?tab=mood'));
  });

  it('opens on the tab the address names, and on the week for a name it does not know', async () => {
    serve();
    await openReview('/review?tab=mood');
    expect(screen.getByRole('radio', { name: 'المزاج' }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(location.pathname).toBe('/review'));
  });

  it('an unknown tab is the week', async () => {
    serve();
    await openReview('/review?tab=nothing');
    expect(screen.getByRole('radio', { name: 'الأسبوع' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('the week tab: four numbers and three lists', () => {
  it('shows the morning and evening journals, the meditation and the English of the week', async () => {
    serve();
    const figures = await openWeek();
    const items = within(figures).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    const text = items.map((li) => li.textContent ?? '');
    expect(text[0]).toContain('يومية الصباح');
    expect(text[0]).toContain('4');
    expect(text[0]).toContain('من 7');
    expect(text[1]).toContain('يومية المساء');
    expect(text[1]).toContain('5');
    expect(text[2]).toContain('التأمل والتصور');
    expect(text[2]).toContain('2');
    expect(text[2]).toContain('من 5');
    expect(text[3]).toContain('الإنجليزية');
    expect(text[3]).toContain('85');
    expect(text[3]).toContain('من 285');
    expect(text[3]).toContain('AC7.4');
  });

  it('a criterion no habit carries is not drawn', async () => {
    serve({ 'GET /v1/habits': () => json([WALK, ENGLISH]) });
    const figures = await openWeek();
    const labels = within(figures).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(labels).toHaveLength(3);
    expect(labels.join(' ')).not.toContain('التأمل والتصور');
  });

  it('says the days kept of the daily habits, the abstain habit included', async () => {
    serve();
    await openWeek();
    // walk 7 of 7, the abstain habit 7 of 7, and the habit nobody logged 0 of 7
    expect(screen.getByText('أيام العادات اليومية: 14 من 21')).toBeTruthy();
  });

  it('has the three lists «تمّ» and «معطَّل» and «التالي»', async () => {
    serve();
    await openWeek();
    const done = screen.getByRole('list', { name: 'تمّ' });
    expect(within(done).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['المشي']);
    const blocked = screen.getByRole('list', { name: 'معطَّل' });
    // the two weekly habits are behind their pace on the last day of the week, then the late day habit,
    // then the milestone past its day
    expect(within(blocked).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'دقائق الإنجليزية',
      'جلسة تأمّل',
      'قراءة المساء',
      'مراجعة الميزانية',
    ]);
    const next = screen.getByRole('list', { name: 'التالي' });
    expect(within(next).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['حجز دورة الإنجليزية']);
  });

  it('a list without items says «لا شيء»', async () => {
    serve({ 'GET /v1/goals': () => json(goals({ milestones: [] })), 'GET /v1/habit-logs': () => json({ logs: [] }) });
    await openWeek();
    const next = screen.getByRole('list', { name: 'التالي' });
    expect(next.textContent).toContain('لا شيء');
  });

  it('names the week by its first and last day', async () => {
    serve();
    await openWeek();
    expect(screen.getByText('من 8 نوفمبر إلى 14 نوفمبر')).toBeTruthy();
  });

  it('reads the journal of the week, the habits and their logs, and the goals', async () => {
    const s = serve();
    await openWeek();
    const journal = s.of('GET', '/v1/journal')[0];
    expect(journal?.search).toContain('from=2026-11-08');
    expect(journal?.search).toContain('to=2026-11-14');
    const logs = s.of('GET', '/v1/habit-logs')[0];
    expect(logs?.search).toContain('to=2026-11-14');
    expect(s.of('GET', '/v1/goals')).toHaveLength(1);
  });

  it('a journal waiting in the outbox counts before it is sent', async () => {
    serve({ 'GET /v1/journal': () => json({ entries: WEEK_JOURNAL.slice(1) }) });
    await enqueue('journal_saved', { part: 'morning', day: '2026-11-08', answers: {} }, new Date('2026-11-08T05:00:00Z'));
    const figures = await openWeek();
    await waitFor(() => expect(within(figures).getAllByRole('listitem')[0]?.textContent).toContain('4'));
  });

  it('uses the digits of the setting', async () => {
    setDigits('arab');
    serve({ 'GET /v1/settings': () => json(settings({ digits: 'arab' })) });
    const figures = await openWeek();
    expect(within(figures).getAllByRole('listitem')[3]?.textContent).toContain('٢٨٥');
  });
});

describe('the week tab: the weekly insight', () => {
  it('has one prominent button, «توليد مراجعة الأسبوع»', async () => {
    serve();
    await openWeek();
    const button = screen.getByRole('button', { name: 'توليد مراجعة الأسبوع' });
    expect(button.className).toContain('btn-primary');
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('nothing goes to the provider by visiting the page', async () => {
    const s = serve();
    await openWeek();
    expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(0);
  });

  it('the button asks once, with the day, and shows the two lines, the cards and the days', async () => {
    const s = serve({
      'POST /v1/insights/weekly': () =>
        json(weekly({ cards: [card('journal:2026-11-09:evening', { label: 'يومية المساء', value: null, text: 'ضغط العمل' }), card('habit:read')], source_ids: ['journal:2026-11-09:evening', 'habit:read'], days: ['2026-11-09', '2026-11-10'] })),
    });
    await openWeek();
    press('توليد مراجعة الأسبوع');
    expect(await screen.findByText('الموضوع المتكرر: ضغط العمل مساءً.')).toBeTruthy();
    expect(screen.getByText('المساء أقل من الصباح.')).toBeTruthy();
    expect(screen.getByText(/^من أيام:/).textContent).toMatch(/9 نوفمبر.*10 نوفمبر/);
    const cards = screen.getByRole('list', { name: 'مصادر الجواب' });
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2);
    expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(1);
    expect(s.of('POST', '/v1/insights/weekly')[0]?.body).toEqual({ day: '2026-11-14', regenerate: false });
    expect(screen.getByText('تقدير')).toBeTruthy();
  });

  it('a missing consent asks for it, and after «موافقة» the question goes out again once', async () => {
    let allowed = false;
    const s = serve({
      'POST /v1/insights/weekly': () => (allowed ? json(weekly()) : consentRequired()),
      'GET /v1/ai/consent': () => json(consent()),
      'PUT /v1/ai/consent': () => {
        allowed = true;
        return json(consent({ granted: true }));
      },
    });
    await openWeek();
    press('توليد مراجعة الأسبوع');
    const dialog = await screen.findByRole('dialog', { name: /الموافقة/ });
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'موافقة' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'موافقة' }));
    expect(await screen.findByText('الموضوع المتكرر: ضغط العمل مساءً.')).toBeTruthy();
    expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(2);
  });

  it('«ليس الآن» leaves the card paused, with the way to turn it on', async () => {
    serve({ 'POST /v1/insights/weekly': () => consentRequired(), 'GET /v1/ai/consent': () => json(consent()) });
    await openWeek();
    press('توليد مراجعة الأسبوع');
    const dialog = await screen.findByRole('dialog', { name: /الموافقة/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'ليس الآن' }));
    expect(await screen.findByText('الذكاء الاصطناعي متوقف حتى الموافقة')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تفعيل الذكاء الاصطناعي' })).toBeTruthy();
  });

  it('a fixed line (out of scope, no data) is a plain reply, not an error', async () => {
    const line = 'لا بيانات كافية.';
    serve({ 'POST /v1/insights/weekly': () => json(weekly({ lines: [line], source_ids: [], cards: [], days: [] })) });
    await openWeek();
    press('توليد مراجعة الأسبوع');
    expect(await screen.findByText(line)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the words of the server when the provider fails, and the way to try again', async () => {
    const s = serve({ 'POST /v1/insights/weekly': () => coded(502, 'تعذّر الحصول على رد صالح', 'provider_error') });
    await openWeek();
    press('توليد مراجعة الأسبوع');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('تعذّر الحصول على رد صالح');
    press('إعادة المحاولة');
    await waitFor(() => expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(2));
  });

  it('a reply that breaks the limits is not shown: «تعذّر التحليل اليوم»', async () => {
    serve({ 'POST /v1/insights/weekly': () => json(weekly({ lines: ['أ', 'ب', 'ج'] })) });
    await openWeek();
    press('توليد مراجعة الأسبوع');
    expect(await screen.findByText('تعذّر التحليل اليوم')).toBeTruthy();
    expect(screen.queryByText('ب')).toBeNull();
  });

  it('without a connection nothing is sent and the page says «يحتاج اتصالاً»', async () => {
    const s = serve();
    await openWeek();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    press('توليد مراجعة الأسبوع');
    expect(await screen.findByText('يحتاج اتصالاً')).toBeTruthy();
    expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(0);
  });

  it('the stored review of this week shows without asking, and is not among the earlier ones', async () => {
    const s = serve({ 'GET /v1/reviews': () => json({ items: [weekly({ lines: ['من هذا الأسبوع.'], cards: [], source_ids: [], days: [] }), weekly({ day: '2026-11-01', id: '00000000-0000-7000-8000-000000000021', lines: ['من الأسبوع الماضي.'] })] }) });
    await openWeek();
    expect(await screen.findByText('من هذا الأسبوع.')).toBeTruthy();
    expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(0);
    const earlier = screen.getByRole('region', { name: 'المراجعات السابقة' });
    expect(within(earlier).queryByText('من هذا الأسبوع.')).toBeNull();
    expect(within(earlier).getByText('من الأسبوع الماضي.')).toBeTruthy();
  });
});

describe('the week tab: asking again (fix round 1, M-4)', () => {
  it('after a reply the button is «إعادة التوليد», and it sends regenerate', async () => {
    const s = serve();
    await openWeek();
    press('توليد مراجعة الأسبوع');
    await screen.findByText('الموضوع المتكرر: ضغط العمل مساءً.');
    expect(screen.queryByRole('button', { name: 'توليد مراجعة الأسبوع' })).toBeNull();
    expect(s.of('POST', '/v1/insights/weekly')[0]?.body).toEqual({ day: '2026-11-14', regenerate: false });
    press('إعادة التوليد');
    await waitFor(() => expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(2));
    expect(s.of('POST', '/v1/insights/weekly')[1]?.body).toEqual({ day: '2026-11-14', regenerate: true });
    // still one prominent button
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('a review already stored for the week has «إعادة التوليد» from the start, and no call is made by showing it', async () => {
    const s = serve({ 'GET /v1/reviews': () => json({ items: [weekly({ cards: [], source_ids: [], days: [] })] }) });
    await openWeek();
    await screen.findByText('الموضوع المتكرر: ضغط العمل مساءً.');
    expect(screen.queryByRole('button', { name: 'توليد مراجعة الأسبوع' })).toBeNull();
    expect(screen.getByRole('button', { name: 'إعادة التوليد' })).toBeTruthy();
    expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(0);
  });

  it('a double click while the answer is awaited sends one request', async () => {
    let release: (r: Response) => void = () => undefined;
    const s = serve({ 'POST /v1/insights/weekly': () => new Promise<Response>((resolve) => (release = resolve)) });
    await openWeek();
    const button = screen.getByRole('button', { name: 'توليد مراجعة الأسبوع' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(1));
    release(json(weekly()));
    await screen.findByText('الموضوع المتكرر: ضغط العمل مساءً.');
    expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(1);
  });

  it('the retry after a failure sends what the failed press sent', async () => {
    const s = serve({ 'POST /v1/insights/weekly': () => coded(502, 'تعذّر الحصول على رد صالح', 'provider_error') });
    await openWeek();
    press('توليد مراجعة الأسبوع');
    await screen.findByRole('alert');
    press('إعادة المحاولة');
    await waitFor(() => expect(s.of('POST', '/v1/insights/weekly')).toHaveLength(2));
    expect(s.of('POST', '/v1/insights/weekly').map((c) => c.body)).toEqual([
      { day: '2026-11-14', regenerate: false },
      { day: '2026-11-14', regenerate: false },
    ]);
  });
});

describe('the week tab: a stored review is shown as it was stored (fix round 1, M-3)', () => {
  const ONE_LINE = settings({ ai_lines: 1 });
  const TWO = ['السطر الأول من مراجعة قديمة.', 'السطر الثاني منها.'];

  it('a two-line review of a past week still shows both lines when ai_lines is 1 now', async () => {
    serve({
      'GET /v1/settings': () => json(ONE_LINE),
      'GET /v1/reviews': () => json({ items: [weekly({ day: '2026-11-01', id: '00000000-0000-7000-8000-000000000031', lines: TWO })] }),
    });
    await openWeek();
    const section = await screen.findByRole('region', { name: 'المراجعات السابقة' });
    await waitFor(() => expect(within(section).getByText(TWO[0] as string)).toBeTruthy());
    expect(within(section).getByText(TWO[1] as string)).toBeTruthy();
    expect(within(section).queryByText('تعذّر التحليل اليوم')).toBeNull();
  });

  it('so does the stored review of this week', async () => {
    serve({
      'GET /v1/settings': () => json(ONE_LINE),
      'GET /v1/reviews': () => json({ items: [weekly({ lines: TWO, cards: [], source_ids: [], days: [] })] }),
    });
    await openWeek();
    expect(await screen.findByText(TWO[1] as string)).toBeTruthy();
    expect(screen.queryByText('تعذّر التحليل اليوم')).toBeNull();
  });

  it('the other guards still hold for a stored row: a line with a new line in it is not shown', async () => {
    serve({
      'GET /v1/reviews': () => json({ items: [weekly({ day: '2026-11-01', id: '00000000-0000-7000-8000-000000000032', lines: ['سطر\nمكسور'] })] }),
    });
    await openWeek();
    const section = await screen.findByRole('region', { name: 'المراجعات السابقة' });
    await waitFor(() => expect(within(section).getByText('تعذّر التحليل اليوم')).toBeTruthy());
  });

  it('a new reply is still held to the lines asked for now: two lines with ai_lines 1 is not shown', async () => {
    const s = serve({ 'GET /v1/settings': () => json(ONE_LINE) });
    await openWeek();
    await waitFor(() => expect(s.of('GET', '/v1/settings')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    press('توليد مراجعة الأسبوع');
    expect(await screen.findByText('تعذّر التحليل اليوم')).toBeTruthy();
  });
});

describe('the week tab: the earlier reviews', () => {
  const OLD = [
    weekly({ day: '2026-11-01', id: '00000000-0000-7000-8000-000000000021', lines: ['أسبوع تشرين الأول: ثبات الصباح.'] }),
    weekly({ day: '2026-10-25', id: '00000000-0000-7000-8000-000000000022', lines: ['أسبوع أبعد: فتور المساء.'], cards: [], days: [] }),
  ];

  it('come from GET /v1/reviews?kind=weekly, newest first, each under its week', async () => {
    const s = serve({ 'GET /v1/reviews': () => json({ items: OLD }) });
    await openWeek();
    const section = await screen.findByRole('region', { name: 'المراجعات السابقة' });
    expect(s.of('GET', '/v1/reviews')[0]?.search).toContain('kind=weekly');
    const items = Array.from(section.querySelectorAll('.review-previous > li'));
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('أسبوع 1 نوفمبر');
    expect(items[0]?.textContent).toContain('أسبوع تشرين الأول: ثبات الصباح.');
    expect(items[1]?.textContent).toContain('أسبوع 25 أكتوبر');
  });

  it('a row stored without its cards shows its words and no card', async () => {
    serve({ 'GET /v1/reviews': () => json({ items: [{ ...OLD[1], cards: undefined, days: undefined }] }) });
    await openWeek();
    const section = await screen.findByRole('region', { name: 'المراجعات السابقة' });
    expect(within(section).getByText('أسبوع أبعد: فتور المساء.')).toBeTruthy();
    expect(within(section).queryByRole('list', { name: 'مصادر الجواب' })).toBeNull();
  });

  it('with none, says so', async () => {
    serve();
    await openWeek();
    const section = await screen.findByRole('region', { name: 'المراجعات السابقة' });
    expect(section.textContent).toContain('لا مراجعات سابقة');
  });
});

describe('the week tab: the four states', () => {
  it('loading: placeholders and aria-busy, nothing else', async () => {
    stubServer({});
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    history.replaceState(null, '', '/review');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'المراجعة' });
    await waitFor(() => expect(document.querySelector('.state-frame[aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'توليد مراجعة الأسبوع' })).toBeNull();
  });

  it('empty: no habit and no journal says what is missing and where to add', async () => {
    serve({ 'GET /v1/habits': () => json([]), 'GET /v1/journal': () => json({ entries: [] }), 'GET /v1/habit-logs': () => json({ logs: [] }) });
    await openReview();
    expect(await screen.findByText('لا عادات ولا يوميات هذا الأسبوع بعد')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'عادة جديدة' }).getAttribute('href')).toBe('/habits/new');
  });

  it('error: «تعذّر التحميل» with «إعادة المحاولة», and no raw code', async () => {
    serve({ 'GET /v1/habits': () => json({ detail: 'خطأ' }, 500) });
    await openReview();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('تعذّر التحميل');
    expect(alert.textContent).not.toMatch(/500|HttpError/);
    serve();
    press('إعادة المحاولة');
    expect(await screen.findByRole('list', { name: 'أرقام الأسبوع' })).toBeTruthy();
  });

  it('offline without a copy: «لا نسخة محفوظة بعد»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await openReview();
    expect(await screen.findByText('لا نسخة محفوظة بعد')).toBeTruthy();
  });

  it('offline with a copy: the last copy with the badge «نسخة محفوظة · بلا اتصال»', async () => {
    serve();
    await openWeek();
    await waitFor(async () => {
      const { readCache } = await import('../../src/data/cache');
      expect(await readCache('review-week:2026-11-14')).toBeDefined();
    });
    await act(async () => cleanup());
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await openReview();
    expect(await screen.findByText('نسخة محفوظة · بلا اتصال')).toBeTruthy();
    const figures = await screen.findByRole('list', { name: 'أرقام الأسبوع' });
    expect(within(figures).getAllByRole('listitem')).toHaveLength(4);
  });
});

// ---------- the journal tab ----------

const FEELING_MOOD = { day: '2026-11-09', score: 4, feelings: ['calm', 'focused'], activities: [] };

/** Morning journals on nine days of November and evening journals on seven, the mood on nine days
 *  (average 3.9), and one October morning. */
function novemberJournal(): JournalEntryOut[] {
  const day = (n: number): string => `2026-11-0${n}`;
  return [
    entry('2026-10-31', 'morning', { note: 'آخر أكتوبر' }),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => entry(day(n), 'morning', n === 9 ? { priorities: [{ title: 'أولوية الصباح' }], note: 'ملاحظة الصباح' } : {})),
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => entry(day(n), 'evening', n === 7 ? { win: 'إنجاز المساء', learned: 'تعلّمت الصبر' } : {})),
  ];
}
const novemberMood = [4, 4, 4, 4, 4, 4, 3, 4, 4].map((score, i) => ({
  day: `2026-11-0${i + 1}`,
  score,
  feelings: i === 6 ? ['calm', 'focused'] : [],
  activities: [],
}));

describe('the journal tab', () => {
  const serveJournal = (over: Record<string, Handler> = {}) =>
    serve({
      'GET /v1/journal': () => json({ entries: novemberJournal() }),
      'GET /v1/mood': () => json({ logs: novemberMood }),
      ...over,
    });

  it('lists the entries newest first, the evening before the morning of the same day', async () => {
    serveJournal();
    await openReview('/review?tab=journal');
    const list = await screen.findByRole('list', { name: 'إدخالات اليوميات' });
    const headings = within(list)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent ?? '');
    expect(headings[0]).toContain('الاثنين، 9 نوفمبر 2026');
    expect(headings[0]).toContain('الصباح');
    expect(headings[1]).toContain('الأحد، 8 نوفمبر 2026');
    // 7 November has both parts: the evening first
    const seventh = headings.filter((h) => h.includes('7 نوفمبر'));
    expect(seventh.map((h) => (h.includes('المساء') ? 'evening' : 'morning'))).toEqual(['evening', 'morning']);
    expect(headings[headings.length - 1]).toContain('31 أكتوبر');
  });

  it('the entries come under a heading of their own, so the headings go from 1 to 2 to 3', async () => {
    serveJournal();
    await openReview('/review?tab=journal');
    await screen.findByRole('list', { name: 'إدخالات اليوميات' });
    expect(screen.getByRole('heading', { level: 2, name: 'الإدخالات' })).toBeTruthy();
  });

  it('reads from the first day of the month that holds the start of the window, so the oldest month card is whole (I-1)', async () => {
    // today is 2026-11-14: the window starts on 2026-05-19, and the card of May needs all of May
    const entries = [
      entry('2026-05-10', 'morning'),
      entry('2026-05-10', 'evening'),
      entry('2026-05-25', 'morning'),
      entry('2026-05-25', 'evening'),
    ];
    const moods = [
      { day: '2026-05-10', score: 3, feelings: [], activities: [] },
      { day: '2026-05-25', score: 4, feelings: [], activities: [] },
    ];
    const between = (search: string) => {
      const q = new URLSearchParams(search);
      return (day: string): boolean => day >= (q.get('from') ?? '') && day <= (q.get('to') ?? '');
    };
    const s = serveJournal({
      'GET /v1/journal': (call) => json({ entries: entries.filter((e) => between(call.search)(e.day)) }),
      'GET /v1/mood': (call) => json({ logs: moods.filter((m) => between(call.search)(m.day)) }),
    });
    await openReview('/review?tab=journal');
    expect(await screen.findByText('مايو 2026: يومان صباحاً، يومان مساءً، متوسط المزاج 3.5 · للوعي الذاتي')).toBeTruthy();
    expect(s.of('GET', '/v1/journal')[0]?.search).toContain('from=2026-05-01');
    expect(s.of('GET', '/v1/mood')[0]?.search).toContain('from=2026-05-01');
    expect(s.of('GET', '/v1/habit-logs')[0]?.search).toContain('from=2026-05-01');
  });

  it('the month card has a line of commitment: the habit days kept, as a percent', async () => {
    const walk = habit('walk', 'المشي');
    const logs = DAYS.slice(0, 7).map((d) => log('walk', d));
    serveJournal({ 'GET /v1/habits': () => json([walk]), 'GET /v1/habit-logs': () => json({ logs }) });
    await openReview('/review?tab=journal');
    // 1 to 14 November are due (the habit started on 31 October): 7 kept
    expect(await screen.findByText('الالتزام بالعادات اليومية: 50% (7 من 14)')).toBeTruthy();
    // October holds one due day (the 31st), not kept
    expect(screen.getByText('الالتزام بالعادات اليومية: 0% (0 من 1)')).toBeTruthy();
  });

  it('a month without a daily habit day has no commitment line', async () => {
    serveJournal({ 'GET /v1/habits': () => json([]), 'GET /v1/habit-logs': () => json({ logs: [] }) });
    await openReview('/review?tab=journal');
    await screen.findByText('نوفمبر 2026: 9 أيام صباحاً، 7 مساءً، متوسط المزاج 3.9 · للوعي الذاتي');
    expect(screen.queryByText(/الالتزام بالعادات اليومية/)).toBeNull();
  });

  it('the commitment uses the digits of the setting', async () => {
    setDigits('arab');
    const walk = habit('walk', 'المشي');
    serveJournal({
      'GET /v1/settings': () => json(settings({ digits: 'arab' })),
      'GET /v1/habits': () => json([walk]),
      'GET /v1/habit-logs': () => json({ logs: DAYS.slice(0, 7).map((d) => log('walk', d)) }),
    });
    await openReview('/review?tab=journal');
    expect(await screen.findByText(/الالتزام بالعادات اليومية: ٥٠٪ \(٧ من ١٤\)/)).toBeTruthy();
  });

  it('one morning and one evening are written in one form: «يوم صباحاً، يوم مساءً» (M-1)', async () => {
    serveJournal({
      'GET /v1/journal': () => json({ entries: [entry('2026-09-03', 'morning'), entry('2026-09-03', 'evening')] }),
      'GET /v1/mood': () => json({ logs: [] }),
    });
    await openReview('/review?tab=journal');
    expect(await screen.findByText('سبتمبر 2026: يوم صباحاً، يوم مساءً، لا تسجيل للمزاج · للوعي الذاتي')).toBeTruthy();
  });

  it('shows the words of an entry', async () => {
    serveJournal();
    await openReview('/review?tab=journal');
    expect(await screen.findByText('ملاحظة الصباح')).toBeTruthy();
    expect(screen.getByText('أولوية الصباح')).toBeTruthy();
    expect(screen.getByText('إنجاز المساء')).toBeTruthy();
    expect(screen.getByText('تعلّمت الصبر')).toBeTruthy();
  });

  it('shows the feelings of the day as chips with the entry', async () => {
    serveJournal({ 'GET /v1/mood': () => json({ logs: [...novemberMood.slice(0, 6), { ...FEELING_MOOD, day: '2026-11-07', score: 3 }, ...novemberMood.slice(7)] }) });
    await openReview('/review?tab=journal');
    const list = await screen.findByRole('list', { name: 'إدخالات اليوميات' });
    const chips = within(list).getByRole('list', { name: 'المشاعر' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['هدوء', 'تركيز']);
  });

  it('the month card says the days, the mood and that it is for self-awareness', async () => {
    serveJournal();
    await openReview('/review?tab=journal');
    expect(await screen.findByText('نوفمبر 2026: 9 أيام صباحاً، 7 مساءً، متوسط المزاج 3.9 · للوعي الذاتي')).toBeTruthy();
    expect(screen.getByText('أكتوبر 2026: يوم صباحاً، 0 مساءً، لا تسجيل للمزاج · للوعي الذاتي')).toBeTruthy();
  });

  it('reads about half a year of the journal and the mood, from the first of a month (the contract of fix round 1, I-1)', async () => {
    const s = serveJournal();
    await openReview('/review?tab=journal');
    await screen.findByRole('list', { name: 'إدخالات اليوميات' });
    expect(s.of('GET', '/v1/journal')[0]?.search).toContain('to=2026-11-14');
    expect(s.of('GET', '/v1/journal')[0]?.search).toContain('from=2026-05-01');
    expect(s.of('GET', '/v1/mood')[0]?.search).toContain('from=2026-05-01');
  });

  it('shows twenty entries and adds twenty more on «عرض المزيد»', async () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`2026-10-${String(1 + i).padStart(2, '0')}`.slice(0, 10), 'morning')).filter((e) => e.day <= '2026-10-31');
    serveJournal({ 'GET /v1/journal': () => json({ entries: many }) });
    await openReview('/review?tab=journal');
    const list = await screen.findByRole('list', { name: 'إدخالات اليوميات' });
    expect(within(list).getAllByRole('heading', { level: 3 })).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'عرض المزيد' }));
    expect(within(list).getAllByRole('heading', { level: 3 })).toHaveLength(30);
    expect(screen.queryByRole('button', { name: 'عرض المزيد' })).toBeNull();
  });

  it('empty: says there is no entry yet, with the way to start one', async () => {
    serveJournal({ 'GET /v1/journal': () => json({ entries: [] }), 'GET /v1/mood': () => json({ logs: [] }) });
    await openReview('/review?tab=journal');
    expect(await screen.findByText('لا إدخالات بعد')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'بدء يومية الصباح' }).getAttribute('href')).toBe('/day/morning');
  });

  it('error and offline without a copy', async () => {
    serveJournal({ 'GET /v1/journal': () => json({ detail: 'خطأ' }, 500) });
    await openReview('/review?tab=journal');
    expect((await screen.findByRole('alert')).textContent).toContain('تعذّر التحميل');
    await act(async () => cleanup());
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await openReview('/review?tab=journal');
    expect(await screen.findByText('لا نسخة محفوظة بعد')).toBeTruthy();
  });
});

// ---------- the mood tab ----------

const dayN = (n: number): string => new Date(Date.UTC(2026, 9, 24 + n)).toISOString().slice(0, 10);
/** Design 9.5: the mood on the days of the walk averages 4.1, on the others 3.4. */
const STORY_SCORES = [4, 4, 4, 4, 4, 4, 5, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4];
const storyMood = STORY_SCORES.map((score, i) => ({ day: dayN(i), score, feelings: [], activities: [] }));
const storyLogs = STORY_SCORES.slice(0, 7).map((_, i) => log('walk', dayN(i)));
const OLD_WALK = habit('walk', 'المشي', { start_day: '2026-10-01' });

describe('the mood tab', () => {
  const serveMood = (over: Record<string, Handler> = {}) =>
    serve({
      'GET /v1/habits': () => json([OLD_WALK]),
      'GET /v1/habit-logs': () => json({ logs: storyLogs }),
      'GET /v1/mood': () => json({ logs: storyMood }),
      ...over,
    });

  it('draws the year grid with a label that says the days with a mood and their average', async () => {
    serveMood();
    await openReview('/review?tab=mood');
    const grid = await screen.findByRole('img', { name: /^المزاج في 2026/ });
    expect(grid.getAttribute('aria-label')).toBe('المزاج في 2026: 17 يوماً مسجّلة، المتوسط 3.7');
    expect(grid.querySelectorAll('[data-score]')).toHaveLength(17);
  });

  it('has a text key with the five grades, from the lowest to the highest', async () => {
    serveMood();
    await openReview('/review?tab=mood');
    const key = await screen.findByRole('list', { name: 'مفتاح درجات المزاج' });
    const items = within(key).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['1 الأدنى', '2', '3', '4', '5 الأعلى']);
  });

  it('the five grades are five shades of one blue, and none is red', async () => {
    const all = [1, 2, 3, 4, 5].map((score, i) => ({ day: dayN(i), score, feelings: [], activities: [] }));
    serveMood({ 'GET /v1/mood': () => json({ logs: all }) });
    await openReview('/review?tab=mood');
    const grid = await screen.findByRole('img', { name: /^المزاج في 2026/ });
    const shades = new Set<string>();
    for (const cell of Array.from(grid.querySelectorAll('[data-score]'))) shades.add(`${cell.getAttribute('data-score')}:${cell.getAttribute('fill-opacity')}`);
    expect([...shades].sort()).toEqual(['1:0.2', '2:0.4', '3:0.6', '4:0.8', '5:1']);
    const css = readFileSync(join(import.meta.dirname, '../../src/charts/year-grid.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/signal|[^\w-]red[^\w-]/);
    expect(css).toMatch(/var\(--c-blue\)/);
  });

  it('shows the mood of the activities: 4.1 on its days, 3.4 on the others, for self-awareness', async () => {
    serveMood();
    await openReview('/review?tab=mood');
    expect(await screen.findByText('المشي: 4.1 في أيامه، و3.4 في غيرها · للوعي الذاتي')).toBeTruthy();
  });

  it('reads the mood of the year and the logs of the same days', async () => {
    const s = serveMood();
    await openReview('/review?tab=mood');
    await screen.findByRole('img', { name: /^المزاج في 2026/ });
    expect(s.of('GET', '/v1/mood')[0]?.search).toContain('from=2026-01-01');
    expect(s.of('GET', '/v1/mood')[0]?.search).toContain('to=2026-11-14');
    expect(s.of('GET', '/v1/habit-logs')[0]?.search).toContain('from=2026-01-01');
  });

  it('with fewer than five days: «لا بيانات كافية», and the grid still shows what there is', async () => {
    serveMood({ 'GET /v1/mood': () => json({ logs: storyMood.slice(0, 4) }) });
    await openReview('/review?tab=mood');
    expect(await screen.findByText('لا بيانات كافية')).toBeTruthy();
    expect(screen.getByRole('img', { name: /4 أيام/ })).toBeTruthy();
    expect(screen.queryByText(/في أيامه/)).toBeNull();
  });

  it('a habit with only four days on one side has no line', async () => {
    serveMood({ 'GET /v1/habit-logs': () => json({ logs: storyLogs.slice(0, 4) }) });
    await openReview('/review?tab=mood');
    expect(await screen.findByText('لا بيانات كافية')).toBeTruthy();
  });

  it('empty: no mood at all says so, with the way to log one', async () => {
    serveMood({ 'GET /v1/mood': () => json({ logs: [] }) });
    await openReview('/review?tab=mood');
    expect(await screen.findByText('لا مزاج مسجَّل بعد')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'إغلاق اليوم' }).getAttribute('href')).toBe('/day/evening');
  });

  it('error, and offline without a copy', async () => {
    serveMood({ 'GET /v1/mood': () => json({ detail: 'خطأ' }, 500) });
    await openReview('/review?tab=mood');
    expect((await screen.findByRole('alert')).textContent).toContain('تعذّر التحميل');
    await act(async () => cleanup());
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await openReview('/review?tab=mood');
    expect(await screen.findByText('لا نسخة محفوظة بعد')).toBeTruthy();
  });
});

describe('the pages of the review hold no watch figure and no gendered address', () => {
  it('the month card and the week speak in numbers and nouns', async () => {
    serve({ 'GET /v1/journal': () => json({ entries: novemberJournal() }), 'GET /v1/mood': () => json({ logs: novemberMood }) });
    await openReview('/review?tab=journal');
    await screen.findByRole('list', { name: 'إدخالات اليوميات' });
    expect(document.body.textContent).not.toMatch(/نوم|تعافي|طاقة|ضربات/);
  });
});
