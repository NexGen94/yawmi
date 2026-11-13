// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/app';
import { READY_QUESTIONS } from '../../src/pages/ask/AskPanel';
import { closeDb } from '../../src/sync/outbox';
import { card, coded, consent, consentRequired, grounded, json, memoryItem, settings, stubServer, type Handler } from '../helpers/ai-fixtures';

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  localStorage.clear();
  history.replaceState(null, '', '/');
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ctrlK = (): boolean => fireEvent.keyDown(document, { code: 'KeyK', key: 'ن', ctrlKey: true });

function serve(over: Record<string, Handler> = {}) {
  return stubServer({
    'GET /v1/settings': () => json(settings()),
    'GET /v1/ai/consent': () => json(consent({ granted: true })),
    'POST /v1/ask': () => json(grounded()),
    ...over,
  });
}

/** Opens the panel from the header button, as a person would, and returns the dialog. */
async function openPanel(): Promise<HTMLElement> {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'اسأل' }));
  const dialog = await screen.findByRole('dialog', { name: 'اسأل' });
  await within(dialog).findByLabelText('السؤال'); // the panel is a lazy chunk
  return dialog;
}

const ask = async (dialog: HTMLElement, question: string): Promise<void> => {
  fireEvent.input(within(dialog).getByLabelText('السؤال'), { target: { value: question } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'سؤال' }));
};

describe('the ask panel: opening and closing', () => {
  it('Ctrl+K opens the panel with the focus in the question field', async () => {
    serve();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'الرئيسية' });
    ctrlK();
    const dialog = await screen.findByRole('dialog', { name: 'اسأل' });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('السؤال')));
  });

  it('Esc closes it and the focus goes back to the button that opened it', async () => {
    serve();
    render(<App />);
    const button = await screen.findByRole('button', { name: 'اسأل' });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole('dialog', { name: 'اسأل' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('opening it twice leaves one panel', async () => {
    serve();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'الرئيسية' });
    ctrlK();
    await screen.findByRole('dialog', { name: 'اسأل' });
    ctrlK();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('the /ask page holds the same panel in the page, and Ctrl+K there focuses its field', async () => {
    serve();
    history.replaceState(null, '', '/ask');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'اسأل' });
    const field = await screen.findByLabelText('السؤال');
    ctrlK();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
});

describe('the ask panel: the question', () => {
  it('the default range is «7 أيام»', async () => {
    serve();
    const dialog = await openPanel();
    const group = within(dialog).getByRole('radiogroup', { name: 'المدى' });
    expect(within(group).getByRole('radio', { name: '7 أيام' }).getAttribute('aria-checked')).toBe('true');
    expect(within(group).getByRole('radio', { name: '30 يوماً' })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: 'الدورة' })).toBeTruthy();
  });

  it('the body of the request has two keys only: question and range', async () => {
    const s = serve();
    const dialog = await openPanel();
    await ask(dialog, 'ما حالة أهدافي؟');
    await within(dialog).findByText('المحطة O1 متأخرة يومين.');
    const [call] = s.of('POST', '/v1/ask');
    expect(call?.body).toEqual({ question: 'ما حالة أهدافي؟', range: '7d' });
    expect(Object.keys(call?.body as object).sort()).toEqual(['question', 'range']);
  });

  it('the range that was chosen goes with the question', async () => {
    const s = serve();
    const dialog = await openPanel();
    fireEvent.click(within(dialog).getByRole('radio', { name: '30 يوماً' }));
    await ask(dialog, 'س');
    await waitFor(() => expect(s.of('POST', '/v1/ask')).toHaveLength(1));
    expect((s.of('POST', '/v1/ask')[0]?.body as { range: string }).range).toBe('30d');
  });

  it('the three ready questions are there with their words, and one sends itself', async () => {
    expect(READY_QUESTIONS).toEqual(['ما حالة أهدافي هذا الأسبوع؟', 'أين التقدّم وأين التأخر؟', 'ما علاقة مزاجي بعاداتي؟']);
    const s = serve();
    const dialog = await openPanel();
    for (const q of READY_QUESTIONS) expect(within(dialog).getByRole('button', { name: q })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'أين التقدّم وأين التأخر؟' }));
    await waitFor(() => expect(s.of('POST', '/v1/ask')).toHaveLength(1));
    expect(s.of('POST', '/v1/ask')[0]?.body).toEqual({ question: 'أين التقدّم وأين التأخر؟', range: '7d' });
  });

  it('an empty question sends nothing', async () => {
    const s = serve();
    const dialog = await openPanel();
    fireEvent.click(within(dialog).getByRole('button', { name: 'سؤال' }));
    expect(s.of('POST', '/v1/ask')).toHaveLength(0);
  });
});

describe('the ask panel: the answer', () => {
  it('shows two lines, the number cards and the days they come from', async () => {
    serve({ 'POST /v1/ask': () => json(grounded({ cards: [card('habit:read'), card('goal:O1', { label: 'هدف O1', value: 2, unit: 'من 6', trend: [] })], source_ids: ['habit:read', 'goal:O1'] })) });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    expect(await within(dialog).findByText('القراءة أعلى في أيام المشي.')).toBeTruthy();
    expect(within(dialog).getByText('المحطة O1 متأخرة يومين.')).toBeTruthy();
    const cards = within(dialog).getByRole('list', { name: 'مصادر الجواب' });
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2);
    expect(cards.textContent).toContain('القراءة');
    expect(cards.textContent).toContain('4 من 7');
    expect(within(dialog).getByText(/^من أيام:/).textContent).toMatch(/9 نوفمبر.*10 نوفمبر/);
  });

  it('says it is an estimate', async () => {
    serve();
    const dialog = await openPanel();
    await ask(dialog, 'س');
    await within(dialog).findByText('المحطة O1 متأخرة يومين.');
    expect(within(dialog).getByText(/تقدير/)).toBeTruthy();
  });

  it('a reply with three lines is not shown: «تعذّر التحليل اليوم»', async () => {
    serve({ 'POST /v1/ask': () => json(grounded({ lines: ['أ', 'ب', 'ج'] })) });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    expect(await within(dialog).findByText('تعذّر التحليل اليوم')).toBeTruthy();
    expect(within(dialog).queryByText('ب')).toBeNull();
  });

  it('with ai_lines 1 a reply of two lines is not shown', async () => {
    serve({ 'GET /v1/settings': () => json(settings({ ai_lines: 1 })) });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    expect(await within(dialog).findByText('تعذّر التحليل اليوم')).toBeTruthy();
  });

  it('the out-of-scope line is a plain reply, not an error', async () => {
    const line = 'هذا خارج نطاق المتابعة اليومية، والمختص هو المرجع المناسب.';
    serve({ 'POST /v1/ask': () => json(grounded({ lines: [line], source_ids: [], cards: [], days: [] })) });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    expect(await within(dialog).findByText(line)).toBeTruthy();
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('«حفظ في الذاكرة» posts the answer as a note', async () => {
    const s = serve({ 'POST /v1/ai/memory': () => json(memoryItem('m1', 'note', 'x'), 201) });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    await within(dialog).findByText('المحطة O1 متأخرة يومين.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ في الذاكرة' }));
    await waitFor(() => expect(s.of('POST', '/v1/ai/memory')).toHaveLength(1));
    expect(s.of('POST', '/v1/ai/memory')[0]?.body).toEqual({
      kind: 'note',
      text: 'القراءة أعلى في أيام المشي. المحطة O1 متأخرة يومين.',
    });
    expect(await within(dialog).findByText('حُفظ في الذاكرة')).toBeTruthy();
  });

  it('a full memory is said in the words of the server', async () => {
    serve({ 'POST /v1/ai/memory': () => coded(422, 'الذاكرة ممتلئة: 20 بنداً حدها', 'memory_full') });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    await within(dialog).findByText('المحطة O1 متأخرة يومين.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ في الذاكرة' }));
    expect(await within(dialog).findByText('الذاكرة ممتلئة: 20 بنداً حدها')).toBeTruthy();
  });
});

describe('the ask panel: the four states', () => {
  it('empty: says what to do, before any question', async () => {
    serve();
    const dialog = await openPanel();
    expect(within(dialog).getByText('يمكن كتابة سؤال أو اختيار واحد من الأسئلة الجاهزة')).toBeTruthy();
  });

  it('loading: busy while the provider answers', async () => {
    let release: (r: Response) => void = () => undefined;
    serve({ 'POST /v1/ask': () => new Promise<Response>((resolve) => (release = resolve)) });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    const busy = await within(dialog).findByText('جارٍ التحليل');
    expect(busy.closest('[aria-busy="true"]')).toBeTruthy();
    release(json(grounded()));
    await within(dialog).findByText('المحطة O1 متأخرة يومين.');
    expect(within(dialog).queryByText('جارٍ التحليل')).toBeNull();
  });

  it('error: 503 shows the message of the server', async () => {
    serve({ 'POST /v1/ask': () => coded(503, 'الخدمة الذكية غير مفعّلة', 'ai_not_configured') });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    expect(await within(dialog).findByText('الخدمة الذكية غير مفعّلة')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });

  it('offline: «يحتاج اتصالاً»', async () => {
    serve({ 'POST /v1/ask': () => Promise.reject(new TypeError('Failed to fetch')) });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    expect(await within(dialog).findByText('يحتاج اتصالاً')).toBeTruthy();
  });

  it('offline from the start: nothing is sent', async () => {
    const s = serve();
    const dialog = await openPanel();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await ask(dialog, 'س');
    expect(await within(dialog).findByText('يحتاج اتصالاً')).toBeTruthy();
    expect(s.of('POST', '/v1/ask')).toHaveLength(0);
  });

  it('without the consent the dialog opens, and «موافقة» asks again', async () => {
    let granted = false;
    const s = serve({
      'POST /v1/ask': () => (granted ? json(grounded()) : consentRequired()),
      'GET /v1/ai/consent': () => json(consent()),
      'PUT /v1/ai/consent': () => {
        granted = true;
        return json(consent({ granted: true }));
      },
    });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    const consentDialog = await screen.findByRole('dialog', { name: /Anthropic/ });
    fireEvent.click(within(consentDialog).getByRole('button', { name: 'موافقة' }));
    expect(await screen.findByText('المحطة O1 متأخرة يومين.')).toBeTruthy();
    expect(s.of('POST', '/v1/ask')).toHaveLength(2);
  });

  it('«ليس الآن» leaves the card saying the AI is stopped until the consent', async () => {
    const s = serve({ 'POST /v1/ask': () => consentRequired(), 'GET /v1/ai/consent': () => json(consent()) });
    const dialog = await openPanel();
    await ask(dialog, 'س');
    const consentDialog = await screen.findByRole('dialog', { name: /Anthropic/ });
    await within(consentDialog).findAllByText(/Anthropic/);
    fireEvent.click(within(consentDialog).getByRole('button', { name: 'ليس الآن' }));
    expect(await screen.findByText('الذكاء الاصطناعي متوقف حتى الموافقة')).toBeTruthy();
    expect(s.of('PUT', '/v1/ai/consent')).toHaveLength(0);
  });
});
