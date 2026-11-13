// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, flush, listPending } from '../../src/sync/outbox';

// Nothing here sends the outbox by itself, and a flush answers at once with nothing sent.
vi.mock('../../src/sync/outbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/sync/outbox')>();
  return { ...original, scheduleFlush: vi.fn(), flush: vi.fn(async () => ({ sent: 0, offline: false, quarantined: 0 })) };
});

import { card, coded, consent, consentRequired, insightOut, json, settings, stubServer, type Handler } from '../helpers/ai-fixtures';
import { morningInsight } from '../helpers/today-fixtures';
import { DAY, NOW, click, entry, evening, openDay, pendingOf, todayOut } from './day-helpers';

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.mocked(flush).mockClear();
});

afterEach(() => {
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const LINES = ['إنجاز اليوم أعلى من المعتاد.', 'المحطة O1 ما زالت مفتوحة.'];

function serve(over: Record<string, Handler> = {}, data: { today?: ReturnType<typeof todayOut>; journal?: ReturnType<typeof entry>[] } = {}) {
  return stubServer({
    'GET /v1/today': () => json(data.today ?? todayOut({ habits_due: evening.habits })),
    'GET /v1/journal': () => json({ entries: data.journal ?? [evening.morning] }),
    'GET /v1/mood': () => json({ logs: [] }),
    'GET /v1/reviews': () => json({ items: [] }),
    'GET /v1/settings': () => json(settings()),
    'POST /v1/day/close': () => json(insightOut({ lines: LINES })),
    ...over,
  });
}

/** The page has read the settings of the person (the AI parts follow them). */
async function settled(s: ReturnType<typeof stubServer>): Promise<void> {
  await waitFor(() => expect(s.of('GET', '/v1/settings')).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const closed = () => screen.queryAllByText(/أُغلق اليوم/).length > 0;

describe('closing the day: the summary of the AI', () => {
  it('adds the journal event first, then calls POST /v1/day/close with the day alone', async () => {
    const queueAtCall: string[] = [];
    const s = serve({
      'POST /v1/day/close': async () => {
        queueAtCall.push(...(await listPending()).map((e) => e.type));
        return json(insightOut({ lines: LINES }));
      },
    });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    expect(await screen.findByText(LINES[0] as string)).toBeTruthy();
    expect(screen.getByText(LINES[1] as string)).toBeTruthy();
    expect(queueAtCall).toContain('journal_saved');
    expect(flush).toHaveBeenCalled();
    expect(s.of('POST', '/v1/day/close')).toHaveLength(1);
    expect(s.of('POST', '/v1/day/close')[0]?.body).toEqual({ day: DAY, regenerate: false });
    expect(await pendingOf('journal_saved')).toHaveLength(1);
  });

  it('a failed provider (502) says «تعذّر التحليل اليوم» and the day stays closed', async () => {
    const s = serve({ 'POST /v1/day/close': () => coded(502, 'تعذّر الاتصال بالخدمة الذكية؛ يمكن المحاولة لاحقاً', 'ai_unavailable') });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    expect(await screen.findByText('تعذّر التحليل اليوم')).toBeTruthy();
    expect(closed()).toBe(true);
    expect(await pendingOf('journal_saved')).toHaveLength(1);
  });

  it('a reply the guard refuses (three lines) says the same, and shows none of it', async () => {
    const s = serve({ 'POST /v1/day/close': () => json(insightOut({ lines: ['أ', 'ب', 'ج'] })) });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    expect(await screen.findByText('تعذّر التحليل اليوم')).toBeTruthy();
    expect(screen.queryByText('ج')).toBeNull();
    expect(closed()).toBe(true);
  });

  it('without a consent the day closes and a button «تفعيل الذكاء الاصطناعي» appears, with no dialog', async () => {
    const s = serve({ 'POST /v1/day/close': () => consentRequired(), 'GET /v1/ai/consent': () => json(consent()) });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    expect(await screen.findByRole('button', { name: 'تفعيل الذكاء الاصطناعي' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.of('GET', '/v1/ai/consent')).toHaveLength(0);
    expect(closed()).toBe(true);
    expect(await pendingOf('journal_saved')).toHaveLength(1);
  });

  it('«تفعيل الذكاء الاصطناعي» opens the consent dialog, and «موافقة» brings the summary', async () => {
    let granted = false;
    const s = serve({
      'POST /v1/day/close': () => (granted ? json(insightOut({ lines: LINES })) : consentRequired()),
      'GET /v1/ai/consent': () => json(consent()),
      'PUT /v1/ai/consent': () => {
        granted = true;
        return json(consent({ granted: true }));
      },
    });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    fireEvent.click(await screen.findByRole('button', { name: 'تفعيل الذكاء الاصطناعي' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'موافقة' }));
    expect(await screen.findByText(LINES[0] as string)).toBeTruthy();
    // the first try, the try of the button (refused again, so the dialog opens), the one after «موافقة»
    expect(s.of('POST', '/v1/day/close')).toHaveLength(3);
  });

  it('offline the day closes and the summary says «يحتاج اتصالاً», with a retry', async () => {
    const s = serve({ 'POST /v1/day/close': () => Promise.reject(new TypeError('Failed to fetch')) });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    expect(await screen.findByText('يحتاج اتصالاً')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
    expect(await pendingOf('journal_saved')).toHaveLength(1);
  });

  it('with ai_checkin = morning the close calls no provider', async () => {
    const s = serve({ 'GET /v1/settings': () => json(settings({ ai_checkin: 'morning' })) });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    await waitFor(async () => expect(await pendingOf('journal_saved')).toHaveLength(1));
    expect(s.of('POST', '/v1/day/close')).toHaveLength(0);
  });

  it('one question shows with «أسئلة أخرى», which asks go-deeper once and reveals the chips', async () => {
    const s = serve({
      'POST /v1/day/close': () => json(insightOut({ lines: LINES, question: 'ما الذي يستحق التأمل؟' })),
      'POST /v1/insights/deeper': () =>
        json({
          question: 'ما الذي يستحق التأمل؟',
          options: [
            { title: 'ما الذي ساعد اليوم؟', source_id: 'habit:read' },
            { title: 'ما الذي عاق اليوم؟', source_id: 'habit:read' },
          ],
          source_ids: ['habit:read'],
          refusal: null,
        }),
    });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    expect(await screen.findByText('ما الذي يستحق التأمل؟')).toBeTruthy();
    expect(s.of('POST', '/v1/insights/deeper')).toHaveLength(0);
    click('أسئلة أخرى');
    await waitFor(() => expect(s.of('POST', '/v1/insights/deeper')).toHaveLength(1));
    expect(s.of('POST', '/v1/insights/deeper')[0]?.body).toEqual({ day: DAY });
    const group = await screen.findByRole('group', { name: 'أسئلة أخرى' });
    expect(within(group).getAllByRole('button')).toHaveLength(2);
  });

  it('go-deeper with a refusal shows the matching fixed line as a plain reply', async () => {
    const s = serve({
      'POST /v1/day/close': () => json(insightOut({ lines: LINES, question: 'ما الذي يستحق التأمل؟' })),
      'POST /v1/insights/deeper': () => json({ question: null, options: [], source_ids: [], refusal: 'no_data' }),
    });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    await screen.findByText('ما الذي يستحق التأمل؟');
    click('أسئلة أخرى');
    expect(await screen.findByText('لا بيانات كافية.')).toBeTruthy();
    expect(screen.queryByText('تعذّر التحليل اليوم')).toBeNull();
  });
});

describe('the morning: «اقتراح أولويات»', () => {
  const proposed = insightOut({
    kind: 'morning',
    lines: ['O5 هي الأقرب موعداً.'],
    priorities: [
      { title: 'مراجعة الفصل', source_id: 'goal:O5' },
      { title: 'تمرين المشي', source_id: 'habit:walk' },
    ],
    source_ids: ['goal:O5', 'habit:walk'],
    cards: [card('goal:O5', { kind: 'outcome', label: 'O5', value: null, unit: null, trend: [] }), card('habit:walk', { label: 'المشي' })],
  });

  it('calls POST /v1/insights/morning once and fills the suggestions', async () => {
    const s = serve({ 'POST /v1/insights/morning': () => json(proposed) }, { journal: [] });
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'اقتراح أولويات' });
    await settled(s);
    click('اقتراح أولويات');
    expect(await screen.findByText('مراجعة الفصل')).toBeTruthy();
    expect(screen.getByText('تمرين المشي')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'قبول' })).toHaveLength(2);
    expect(s.of('POST', '/v1/insights/morning')).toHaveLength(1);
    expect(s.of('POST', '/v1/insights/morning')[0]?.body).toEqual({ day: DAY, regenerate: false });
  });

  it('visiting the page calls no provider by itself, and a log does not call it again', async () => {
    const s = serve({ 'POST /v1/insights/morning': () => json(proposed) }, { journal: [] });
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'اقتراح أولويات' });
    await settled(s);
    expect(s.of('POST', '/v1/insights/morning')).toHaveLength(0);
    fireEvent.input(screen.getByLabelText('سطر الحماس'), { target: { value: 'يوم جيد' } });
    expect(s.of('POST', '/v1/insights/morning')).toHaveLength(0);
  });

  it('what the person wrote stays: only empty or suggested slots take a proposal', async () => {
    const s = serve({ 'POST /v1/insights/morning': () => json(proposed) }, { journal: [] });
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'اقتراح أولويات' });
    await settled(s);
    fireEvent.input(screen.getByLabelText('الأولوية 1'), { target: { value: 'كتابتي أنا' } });
    click('اقتراح أولويات');
    expect(await screen.findByText('تمرين المشي')).toBeTruthy();
    expect((screen.getByLabelText('الأولوية 1') as HTMLInputElement).value).toBe('كتابتي أنا');
  });

  it('a failed provider says «تعذّر التحليل اليوم» and the form stays usable', async () => {
    const s = serve({ 'POST /v1/insights/morning': () => coded(502, 'x', 'ai_unavailable') }, { journal: [] });
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'اقتراح أولويات' });
    await settled(s);
    click('اقتراح أولويات');
    expect(await screen.findByText('تعذّر التحليل اليوم')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'حفظ الصباح' })).toBeTruthy();
  });

  it('without a consent the dialog opens from the button', async () => {
    const s = serve({ 'POST /v1/insights/morning': () => consentRequired(), 'GET /v1/ai/consent': () => json(consent()) }, { journal: [] });
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'اقتراح أولويات' });
    await settled(s);
    click('اقتراح أولويات');
    expect(await screen.findByRole('dialog', { name: /Anthropic/ })).toBeTruthy();
  });
});

describe('ai_checkin: where the summary card of the day shows (design section 4.1)', () => {
  const stored = morningInsight({ lines: ['الصباح: ثلاث أولويات مقترحة.'], source_ids: ['goal:O5'], cards: [card('goal:O5')] });
  const morningToday = () => todayOut({ habits_due: evening.habits, insight: stored });
  const REGION = 'ملخص اليوم من الذكاء';

  it('morning: the card is on the morning page', async () => {
    const s = serve({ 'GET /v1/settings': () => json(settings({ ai_checkin: 'morning' })) }, { today: morningToday(), journal: [] });
    await openDay('/day/morning');
    await settled(s);
    const region = await screen.findByRole('region', { name: REGION });
    expect(within(region).getByText('الصباح: ثلاث أولويات مقترحة.')).toBeTruthy();
  });

  it('evening: the card is not on the morning page', async () => {
    const s = serve({ 'GET /v1/settings': () => json(settings({ ai_checkin: 'evening' })) }, { today: morningToday(), journal: [] });
    await openDay('/day/morning');
    await screen.findByRole('button', { name: 'حفظ الصباح' });
    await settled(s);
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
    expect(screen.queryByText('الصباح: ثلاث أولويات مقترحة.')).toBeNull();
  });

  it('a stored row without its cards (before task 18) still shows its text', async () => {
    const old = morningInsight({ lines: ['نص قديم بلا بطاقات.'], source_ids: ['goal:O5'], cards: [] });
    const s = serve(
      { 'GET /v1/settings': () => json(settings({ ai_checkin: 'morning' })) },
      { today: todayOut({ habits_due: evening.habits, insight: old }), journal: [] },
    );
    await openDay('/day/morning');
    await settled(s);
    expect(await screen.findByText('نص قديم بلا بطاقات.')).toBeTruthy();
    expect(screen.queryByText('تعذّر التحليل اليوم')).toBeNull();
  });

  const closedJournal = [evening.morning, entry(DAY, 'evening', { one_minute: true, priorities: [], gratitude: [] })];
  const review = insightOut({ lines: ['ملخص المساء المخزَّن.'], day: DAY });

  it('morning: the card is gone after the closing', async () => {
    const s = serve(
      { 'GET /v1/settings': () => json(settings({ ai_checkin: 'morning' })), 'GET /v1/reviews': () => json({ items: [review] }) },
      { today: morningToday(), journal: closedJournal },
    );
    await openDay('/day/evening');
    await screen.findAllByText(/أُغلق اليوم/);
    await settled(s);
    expect(screen.queryByText('ملخص المساء المخزَّن.')).toBeNull();
    expect(screen.queryByText('الصباح: ثلاث أولويات مقترحة.')).toBeNull();
  });

  it('evening: the summary shows after the closing', async () => {
    const s = serve(
      { 'GET /v1/settings': () => json(settings({ ai_checkin: 'evening' })), 'GET /v1/reviews': () => json({ items: [review] }) },
      { today: morningToday(), journal: closedJournal },
    );
    await openDay('/day/evening');
    await settled(s);
    expect(await screen.findByText('ملخص المساء المخزَّن.')).toBeTruthy();
  });

  it('evening: nothing shows before the closing', async () => {
    const s = serve({ 'GET /v1/reviews': () => json({ items: [review] }) }, { today: morningToday(), journal: [evening.morning] });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    expect(screen.queryByText('ملخص المساء المخزَّن.')).toBeNull();
  });
});

describe('the lines follow ai_lines', () => {
  it('with ai_lines = 1 a summary of two lines is refused', async () => {
    const s = serve({ 'GET /v1/settings': () => json(settings({ ai_lines: 1 })) });
    await openDay('/day/evening');
    await screen.findByRole('button', { name: 'إغلاق اليوم' });
    await settled(s);
    click('إغلاق اليوم');
    expect(await screen.findByText('تعذّر التحليل اليوم')).toBeTruthy();
    expect(screen.queryByText(LINES[0] as string)).toBeNull();
  });
});
