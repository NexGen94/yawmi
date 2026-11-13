// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider, Route, Router } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { components } from '../../src/api/schema';
import { fmt, setDigits } from '../../src/lib/format';
import HabitEditorPage from '../../src/pages/habits/editor';
import { clearOutbox, closeDb, enqueue } from '../../src/sync/outbox';
import { DAY, habit, type HabitOut, NOON_RIYADH } from '../helpers/today-fixtures';

type Draft = components['schemas']['HabitDraft'];
type Overview = components['schemas']['OverviewOut'];

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;
type Answer = () => Response | Promise<Response>;
let answers: Record<string, Answer>;

const OVERVIEW: Overview = {
  outcomes: [
    {
      code: 'O7',
      title: 'إتقان الإنجليزية',
      track: 'مهني',
      target_date: '2027-12-31',
      status: 'جارٍ',
      milestones_total: 4,
      milestones_done: 1,
      completion: 0.25,
      habits: [],
      next_milestone: { page_id: 'ms-7', title: 'اختبار المستوى', due_date: '2026-12-20', cycle_no: 2 },
    },
    {
      code: 'O3',
      title: 'ركيزة النوم',
      track: 'صحي',
      target_date: '2027-12-31',
      status: 'جارٍ',
      milestones_total: 0,
      milestones_done: 0,
      completion: null,
      habits: [],
      next_milestone: null,
    },
  ],
  cards: [{ page_id: 'card-1', title: 'قراءة كتاب', status: null, outcome_codes: ['O3'], habits: [], habits_adherence_avg: null }],
};

const draft = (over: Partial<Draft> = {}): Draft => ({
  title_ar: 'اختبار المستوى',
  goal_ref: 'ms-7',
  outcome: 'O7',
  ac_ref: null,
  kind: 'duration',
  unit: 'min',
  target_per_period: 120,
  period: 'week',
  schedule_kind: 'every_day',
  weekday_mask: null,
  every_n: null,
  anchor_day: null,
  anchor: 'free',
  start_day: DAY,
  end_day: null,
  polarity: 'build',
  identity_text: null,
  reminders: [],
  ...over,
});

const stored = (over: Partial<HabitOut> = {}): HabitOut =>
  habit('u_read', 'قراءة', { created_by: 'user', kind: 'duration', unit: 'min', target_per_period: 20, ...over });

function serve(more: Record<string, Answer> = {}): void {
  answers = {
    'GET /v1/overview': () => json(OVERVIEW),
    'GET /v1/habits': () => json([]),
    'GET /v1/habit-logs': () => json({ logs: [] }),
    'GET /v1/indicators': () => json({ items: [] }),
    ...more,
  };
}

beforeEach(() => {
  calls = [];
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, path: url.pathname, search: url.search, body: text === '' ? undefined : JSON.parse(text) });
    const toHabit = /^\/v1\/goals\/[^/]+\/to-habit$/.test(url.pathname) ? 'POST /v1/goals/{ref}/to-habit' : undefined;
    const answer = answers[toHabit ?? `${request.method} ${url.pathname}`];
    return answer ? answer() : json({ detail: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  serve();
});

afterEach(async () => {
  cleanup();
  setDigits('latn');
  await clearOutbox();
  closeDb();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

function mount(path = '/habits/new') {
  history.replaceState(null, '', path);
  return render(
    <LocationProvider>
      <Router>
        <Route path="/habits/new" component={HabitEditorPage} />
        <Route path="/habits/:code/edit" component={HabitEditorPage} />
        <Route path="/habits/:code" component={({ params }: { params?: { code?: string } }) => <h1>تفاصيل {params?.code}</h1>} />
        <Route default component={() => <p>غير موجود</p>} />
      </Router>
    </LocationProvider>,
  );
}

/** A fresh browser store, so a saved copy of one case never answers for the next. */
const resetDb = (): void => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
};

const type = (label: string, value: string): void => {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
};
const choose = (group: string, name: string): void => {
  fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name }));
};

async function openNew(path = '/habits/new') {
  const view = mount(path);
  await screen.findByRole('heading', { level: 1, name: 'عادة جديدة' });
  return view;
}

async function openEdit(h: HabitOut, extra: Record<string, Answer> = {}) {
  serve({ 'GET /v1/habits': () => json([h]), ...extra });
  const view = mount(`/habits/${h.code}/edit`);
  await screen.findByRole('heading', { level: 1, name: 'تعديل العادة' });
  await screen.findByLabelText('العنوان');
  return view;
}

const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'حفظ العادة' });
const sent = (method: string, path: string): Call[] => calls.filter((c) => c.method === method && c.path === path);

describe('the fields, in the order of the design', () => {
  it('lists source, title, type, unit, target, period, schedule, dates, anchor, identity and reminders', async () => {
    await openNew();
    choose('النوع', 'مدة');
    const order: HTMLElement[] = [
      screen.getByRole('radiogroup', { name: 'المصدر' }),
      screen.getByLabelText('العنوان'),
      screen.getByRole('radiogroup', { name: 'النوع' }),
      screen.getByRole('radiogroup', { name: 'الوحدة' }),
      screen.getByLabelText('الهدف في الفترة'),
      screen.getByRole('radiogroup', { name: 'الفترة' }),
      screen.getByRole('radiogroup', { name: 'الجدول' }),
      screen.getByLabelText('من'),
      screen.getByLabelText('إلى'),
      screen.getByRole('radiogroup', { name: 'طول الفترة' }),
      screen.getByRole('radiogroup', { name: 'الإشارة' }),
      screen.getByLabelText('جملة الهوية'),
      screen.getByRole('group', { name: 'التذكيرات' }),
    ];
    for (let i = 1; i < order.length; i++) {
      const before = order[i - 1] as HTMLElement;
      const after = order[i] as HTMLElement;
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    }
  });

  it('offers the five types and the chips 7, 30, 66, 100, custom and open-ended', async () => {
    await openNew();
    const types = within(screen.getByRole('radiogroup', { name: 'النوع' })).getAllByRole('radio');
    expect(types.map((t) => t.textContent)).toEqual(['نعم أو لا', 'عدد', 'مدة', 'متوسط', 'امتناع']);
    const chips = within(screen.getByRole('radiogroup', { name: 'طول الفترة' })).getAllByRole('radio');
    expect(chips.map((c) => c.textContent)).toEqual([
      fmt.count(7, 'day'),
      fmt.count(30, 'day'),
      fmt.count(66, 'day'),
      fmt.count(100, 'day'),
      'مخصص',
      'مستمرة',
    ]);
  });

  it('starts today, open-ended, as a yes/no habit', async () => {
    await openNew();
    expect((screen.getByLabelText('من') as HTMLInputElement).value).toBe(DAY);
    expect((screen.getByLabelText('إلى') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('radio', { name: 'مستمرة' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'نعم أو لا' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('the period by date and the live summary', () => {
  it('a chip of 30 days from 2026-11-09 ends on 2026-12-08 and the summary says it', async () => {
    await openNew();
    choose('النوع', 'مدة');
    type('العنوان', 'قراءة');
    type('الهدف في الفترة', '20');
    type('من', '2026-11-09');
    choose('طول الفترة', fmt.count(30, 'day'));
    expect((screen.getByLabelText('إلى') as HTMLInputElement).value).toBe('2026-12-08');
    const summary = screen.getByRole('region', { name: 'ملخص العادة' });
    expect(summary.textContent).toContain(`تنتهي في ${fmt.day('2026-12-08')}`);
    expect(summary.textContent).toContain('المطلوب يومياً: 20 دقيقة');
  });

  it('typing another end day makes the chip «مخصص»; open-ended empties it', async () => {
    await openNew();
    type('من', '2026-11-09');
    choose('طول الفترة', fmt.count(30, 'day'));
    type('إلى', '2026-12-20');
    expect(screen.getByRole('radio', { name: 'مخصص' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('region', { name: 'ملخص العادة' }).textContent).toContain(`تنتهي في ${fmt.day('2026-12-20')}`);
    choose('طول الفترة', 'مستمرة');
    expect((screen.getByLabelText('إلى') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('region', { name: 'ملخص العادة' }).textContent).toContain('بلا نهاية');
  });

  it('an end before the start is an error on «إلى» and blocks saving', async () => {
    await openNew();
    type('العنوان', 'قراءة');
    type('من', '2026-11-09');
    type('إلى', '2026-11-01');
    fireEvent.click(saveButton());
    expect(await screen.findByText(/تاريخ النهاية قبل البداية/)).toBeTruthy();
    expect(screen.getByLabelText('إلى').getAttribute('aria-invalid')).toBe('true');
    expect(sent('POST', '/v1/habits')).toHaveLength(0);
  });

  it('shows a weekly need in whole units: the week, and the share of a day rounded up', async () => {
    await openNew();
    choose('النوع', 'مدة');
    choose('الفترة', 'أسبوعية');
    type('الهدف في الفترة', '285');
    const text = screen.getByRole('region', { name: 'ملخص العادة' }).textContent ?? '';
    expect(text).toContain('المطلوب أسبوعياً: 285 دقيقة');
    expect(text).toContain('المطلوب يومياً: 41 دقيقة');
  });

  it('a yes/no weekly habit asks for days, a monthly one for times', async () => {
    await openNew();
    choose('الفترة', 'أسبوعية');
    type('الهدف في الفترة', '5');
    expect(screen.getByRole('region', { name: 'ملخص العادة' }).textContent).toContain(`المطلوب أسبوعياً: ${fmt.count(5, 'day')}`);
  });

  it('says what an abstain habit counts', async () => {
    await openNew();
    choose('النوع', 'امتناع');
    expect(screen.getByRole('region', { name: 'ملخص العادة' }).textContent).toContain('الأيام النظيفة');
  });

  it('puts Arabic-Indic digits through the same formatter when asked', async () => {
    setDigits('arab');
    await openNew();
    choose('النوع', 'مدة');
    type('الهدف في الفترة', '20');
    expect(screen.getByRole('region', { name: 'ملخص العادة' }).textContent).toContain('المطلوب يومياً: ٢٠ دقيقة');
  });
});

describe('types: abstain, average and the identity sentence', () => {
  it('abstain fixes the kind, the period and the target and disables them', async () => {
    await openNew();
    choose('النوع', 'مدة');
    choose('النوع', 'امتناع');
    expect(screen.getByRole('radio', { name: 'يومية' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('radio', { name: 'يومية' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('الهدف في الفترة') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('الهدف في الفترة') as HTMLInputElement).value).toBe('1');
  });

  it('the identity sentence stops at 300 characters', async () => {
    await openNew();
    const field = screen.getByLabelText('جملة الهوية') as HTMLTextAreaElement | HTMLInputElement;
    fireEvent.input(field, { target: { value: 'ق'.repeat(305) } });
    expect(field.value).toHaveLength(300);
  });

  it('saves the identity sentence trimmed', async () => {
    serve({ 'POST /v1/habits': () => json(stored(), 201) });
    await openNew();
    type('العنوان', 'قراءة');
    type('جملة الهوية', ' أنا شخص يقرأ كل يوم ');
    fireEvent.click(saveButton());
    await waitFor(() => expect(sent('POST', '/v1/habits')).toHaveLength(1));
    expect(sent('POST', '/v1/habits')[0]?.body).toMatchObject({ identity_text: 'أنا شخص يقرأ كل يوم' });
  });

  it('an average habit puts its indicator once, with the whole body, after the habit is saved', async () => {
    serve({
      'POST /v1/habits': () => json(stored({ code: 'u_steps', kind: 'count', unit: '', target_per_period: 8000 }), 201),
      'PUT /v1/indicators/habit/u_steps': () => json({}),
    });
    await openNew();
    type('العنوان', 'الخطوات');
    choose('النوع', 'متوسط');
    type('الهدف في الفترة', '8000');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_steps/ });
    expect(sent('PUT', '/v1/indicators/habit/u_steps')).toHaveLength(1);
    expect(sent('PUT', '/v1/indicators/habit/u_steps')[0]?.body).toEqual({
      subject_kind: 'habit',
      subject_ref: 'u_steps',
      source: 'habit_logs',
      measure: 'avg_7d',
      target: 8000,
      period: 'day',
      display: 'number',
    });
    expect(sent('POST', '/v1/habits')).toHaveLength(1);
  });

  it('a failed indicator keeps the habit and opens it for editing with the reason', async () => {
    serve({
      'POST /v1/habits': () => json(stored({ code: 'u_steps', kind: 'count', unit: '', target_per_period: 8000 }), 201),
      'PUT /v1/indicators/habit/u_steps': () => json({ detail: 'x' }, 500),
      'GET /v1/habits': () => json([stored({ code: 'u_steps', kind: 'count', unit: '', target_per_period: 8000 })]),
    });
    await openNew();
    type('العنوان', 'الخطوات');
    choose('النوع', 'متوسط');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: 'تعديل العادة' });
    expect(await screen.findByText(/العادة محفوظة، وتعذّر حفظ المؤشر/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'متوسط' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('saving', () => {
  it('creates the habit and goes to its page', async () => {
    serve({ 'POST /v1/habits': () => json(stored({ code: 'u_new' }), 201) });
    await openNew();
    type('العنوان', 'قراءة');
    choose('النوع', 'مدة');
    type('الهدف في الفترة', '20');
    type('من', '2026-11-09');
    choose('طول الفترة', fmt.count(30, 'day'));
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_new/ });
    expect(sent('POST', '/v1/habits')[0]?.body).toMatchObject({
      title_ar: 'قراءة',
      kind: 'duration',
      unit: 'min',
      period: 'day',
      target_per_period: 20,
      start_day: '2026-11-09',
      end_day: '2026-12-08',
    });
  });

  it('offline: the button is off and «يحتاج اتصالاً» stands beside it', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openNew();
    type('العنوان', 'قراءة');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('يحتاج اتصالاً')).toBeTruthy();
    fireEvent.click(saveButton());
    expect(sent('POST', '/v1/habits')).toHaveLength(0);
  });

  it('the button comes back with the connection', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openNew();
    expect(saveButton().disabled).toBe(true);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.queryByText('يحتاج اتصالاً')).toBeNull();
  });

  it('a 422 whose body times out reads «انتهت المهلة؛ يمكن المحاولة ثانية» and marks no field (N-2)', async () => {
    serve({
      'POST /v1/habits': () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
            },
          }),
          { status: 422 },
        ),
    });
    await openNew();
    type('العنوان', 'قراءة');
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain('انتهت المهلة؛ يمكن المحاولة ثانية');
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('a refusal of a field by the server marks that field', async () => {
    serve({
      'POST /v1/habits': () =>
        json({ detail: 'طلب غير صالح', errors: [{ loc: ['body', 'title_ar'], type: 'string_too_long' }] }, 422),
    });
    await openNew();
    type('العنوان', 'قراءة');
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByLabelText('العنوان').getAttribute('aria-invalid')).toBe('true'));
  });

  it('a server error says so and keeps the form', async () => {
    serve({ 'POST /v1/habits': () => json({ detail: 'x' }, 500) });
    await openNew();
    type('العنوان', 'قراءة');
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain('تعذّر الحفظ');
    expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('قراءة');
  });
});

describe('a habit that is edited', () => {
  it('opens with its values and sends only what changed', async () => {
    const original = stored({ identity_text: 'أنا قارئ' });
    await openEdit(original, { 'PATCH /v1/habits/u_read': () => json({ ...original, title_ar: 'قراءة ليلية' }) });
    expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('قراءة');
    expect((screen.getByLabelText('جملة الهوية') as HTMLInputElement).value).toBe('أنا قارئ');
    type('العنوان', 'قراءة ليلية');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_read/ });
    expect(sent('PATCH', '/v1/habits/u_read')[0]?.body).toEqual({ title_ar: 'قراءة ليلية' });
  });

  it('a habit it does not know says so', async () => {
    serve({ 'GET /v1/habits': () => json([]) });
    mount('/habits/nope/edit');
    expect(await screen.findByText('لا توجد عادة بهذا الرمز.')).toBeTruthy();
  });

  it('opens as an average habit when it has the average indicator, and removes it when it stops', async () => {
    const original = stored({ kind: 'count', unit: '', target_per_period: 8000 });
    await openEdit(original, {
      'GET /v1/indicators': () =>
        json({
          items: [
            {
              subject_kind: 'habit',
              subject_ref: 'u_read',
              source: 'habit_logs',
              measure: 'avg_7d',
              period: 'day',
              display: 'number',
              target: 8000,
            },
          ],
        }),
      'PATCH /v1/habits/u_read': () => json(original),
      'DELETE /v1/indicators/habit/u_read': () => new Response(null, { status: 204 }),
    });
    expect(screen.getByRole('radio', { name: 'متوسط' }).getAttribute('aria-checked')).toBe('true');
    choose('النوع', 'عدد');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_read/ });
    expect(sent('DELETE', '/v1/indicators/habit/u_read')).toHaveLength(1);
  });
});

describe('a system habit', () => {
  const system = stored({
    code: 'meditation',
    title_ar: 'جلسة تأمّل 10 دقائق',
    system: true,
    created_by: 'seed',
    kind: 'boolean',
    unit: '',
    period: 'week',
    target_per_period: 5,
    anchor: 'after_wake',
    reminders: [{ time: '06:30', days_mask: 127 }],
  });

  it('locks every field but the anchor, the reminders and the identity sentence, with the hint', async () => {
    await openEdit(system);
    for (const label of ['العنوان', 'الهدف في الفترة', 'من', 'إلى']) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      expect(field.disabled, label).toBe(true);
    }
    for (const group of ['النوع', 'الفترة', 'طول الفترة']) {
      const radios = within(screen.getByRole('radiogroup', { name: group })).getAllByRole('radio') as HTMLButtonElement[];
      expect(radios.every((r) => r.disabled), group).toBe(true);
    }
    expect(screen.getAllByText('عادة نظامية من الخطة').length).toBeGreaterThan(0);
    expect((screen.getByLabelText('جملة الهوية') as HTMLInputElement).disabled).toBe(false);
    const anchors = within(screen.getByRole('radiogroup', { name: 'الإشارة' })).getAllByRole('radio') as HTMLButtonElement[];
    expect(anchors.some((r) => r.disabled)).toBe(false);
    expect((screen.getByRole('button', { name: 'إضافة تذكير' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the anchor alone when only the anchor changed', async () => {
    await openEdit(system, { 'PATCH /v1/habits/meditation': () => json({ ...system, anchor: 'free' }) });
    choose('الإشارة', 'خلال اليوم');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل meditation/ });
    expect(sent('PATCH', '/v1/habits/meditation')[0]?.body).toEqual({ anchor: 'free' });
  });
});

describe('the type of a habit that has logs (task 13: only the polarity is fixed after the first log)', () => {
  const logged = stored({ kind: 'boolean', unit: '', target_per_period: 1 });
  const polarityRefusal = (): Response =>
    json(
      {
        detail: 'لا يمكن تغيير نوع العادة بعد تسجيلها',
        errors: [{ loc: ['body', 'polarity'], type: 'polarity_locked' }],
      },
      422,
    );
  const aLog = {
    'GET /v1/habit-logs': () => json({ logs: [{ habit_code: 'u_read', day: '2026-11-08', status: 'done', value: null }] }),
  };
  const state = (): Record<string, boolean> =>
    Object.fromEntries(
      (within(screen.getByRole('radiogroup', { name: 'النوع' })).getAllByRole('radio') as HTMLButtonElement[]).map((r) => [
        r.textContent ?? '',
        r.disabled,
      ]),
    );

  it('a build habit with a log blocks «امتناع» alone, and says why beside it', async () => {
    await openEdit(logged, aLog);
    expect(state()).toEqual({ 'نعم أو لا': false, عدد: false, مدة: false, متوسط: false, امتناع: true });
    expect(screen.getByText('لا يمكن تغيير نوع العادة بعد تسجيلها')).toBeTruthy();
    // The log is asked for this habit alone.
    expect(calls.find((c) => c.path === '/v1/habit-logs')?.search).toContain('code=u_read');
  });

  it('an abstain habit with a log blocks the four build types and keeps «امتناع»', async () => {
    const abstain = stored({ kind: 'boolean', unit: '', target_per_period: 1, polarity: 'abstain' });
    await openEdit(abstain, aLog);
    expect(state()).toEqual({ 'نعم أو لا': true, عدد: true, مدة: true, متوسط: true, امتناع: false });
  });

  it('count to average is allowed on a logged habit, and saves the indicator alone', async () => {
    const counted = stored({ kind: 'count', unit: '', target_per_period: 8000 });
    await openEdit(counted, {
      ...aLog,
      'PUT /v1/indicators/habit/u_read': () => json({}),
    });
    choose('النوع', 'متوسط');
    expect(screen.getByRole('radio', { name: 'متوسط' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_read/ });
    expect(sent('PATCH', '/v1/habits/u_read')).toHaveLength(0);
    expect(sent('PUT', '/v1/indicators/habit/u_read')).toHaveLength(1);
  });

  it('build to abstain is blocked on a logged habit: the option does nothing', async () => {
    await openEdit(logged, aLog);
    choose('النوع', 'امتناع');
    expect(screen.getByRole('radio', { name: 'نعم أو لا' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'امتناع' }).getAttribute('aria-checked')).toBe('false');
  });

  it('the log still waiting in the outbox blocks the flip too', async () => {
    await enqueue('habit_logged', { habit_code: 'u_read', day: DAY, status: 'done', value: null } as never);
    await openEdit(logged);
    await waitFor(() => expect(state()['امتناع']).toBe(true));
  });

  it('is free when the habit has no log', async () => {
    await openEdit(logged);
    expect(Object.values(state()).some(Boolean)).toBe(false);
    expect(screen.queryByText('لا يمكن تغيير نوع العادة بعد تسجيلها')).toBeNull();
  });

  it('a 422 polarity_locked says in an alert beside the button that nothing was saved, and why (I-1)', async () => {
    await openEdit(logged, { 'PATCH /v1/habits/u_read': polarityRefusal });
    type('العنوان', 'عنوان آخر');
    choose('النوع', 'امتناع');
    fireEvent.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('لا يمكن تغيير نوع العادة بعد تسجيلها');
    expect(alert.textContent).toContain('لم يُحفظ');
    // It stands in the summary, beside the save button, and the page did not move.
    expect(within(screen.getByRole('region', { name: 'ملخص العادة' })).getByRole('alert')).toBe(alert);
    expect(screen.getByRole('heading', { level: 1, name: 'تعديل العادة' })).toBeTruthy();
    // The other edit is kept, the type goes back, and «امتناع» is blocked from now on.
    expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('عنوان آخر');
    expect(screen.getByRole('radio', { name: 'نعم أو لا' }).getAttribute('aria-checked')).toBe('true');
    expect(state()['امتناع']).toBe(true);
    expect(state()['عدد']).toBe(false);
  });

  it('the alert goes away with the next edit or save attempt', async () => {
    await openEdit(logged, { 'PATCH /v1/habits/u_read': polarityRefusal });
    choose('النوع', 'امتناع');
    fireEvent.click(saveButton());
    await screen.findByRole('alert');
    answers['PATCH /v1/habits/u_read'] = () => json({ ...logged, title_ar: 'x' });
    type('العنوان', 'x');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_read/ });
  });

  it('an average habit comes back as an average after the 422, and the next save keeps its indicator (M-1)', async () => {
    const counted = stored({ kind: 'count', unit: '', target_per_period: 8000 });
    await openEdit(counted, {
      'GET /v1/indicators': () =>
        json({
          items: [{ subject_kind: 'habit', subject_ref: 'u_read', source: 'habit_logs', measure: 'avg_7d', period: 'day', display: 'number', target: 8000 }],
        }),
      'PATCH /v1/habits/u_read': polarityRefusal,
      'PUT /v1/indicators/habit/u_read': () => json({}),
      'DELETE /v1/indicators/habit/u_read': () => new Response(null, { status: 204 }),
    });
    expect(screen.getByRole('radio', { name: 'متوسط' }).getAttribute('aria-checked')).toBe('true');
    choose('النوع', 'امتناع');
    fireEvent.click(saveButton());
    await screen.findByRole('alert');
    expect(screen.getByRole('radio', { name: 'متوسط' }).getAttribute('aria-checked')).toBe('true');
    answers['PATCH /v1/habits/u_read'] = () => json({ ...counted, title_ar: 'y' });
    type('العنوان', 'y');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_read/ });
    expect(sent('DELETE', '/v1/indicators/habit/u_read')).toHaveLength(0);
    expect(sent('PUT', '/v1/indicators/habit/u_read')).toHaveLength(1);
  });
});

describe('a habit from a goal', () => {
  const openPicker = async () => {
    await openNew();
    choose('المصدر', 'من هدف');
  };

  it('lists the outcomes (by their next milestone) and the cards of /v1/overview', async () => {
    await openPicker();
    const list = await screen.findByRole('list', { name: 'الأهداف' });
    expect(within(list).getByRole('button', { name: /O7.*إتقان الإنجليزية.*اختبار المستوى/ })).toBeTruthy();
    expect(within(list).getByRole('button', { name: /قراءة كتاب/ })).toBeTruthy();
    // An outcome with no open milestone cannot be picked, and says why.
    const none = within(list).getByText(/ركيزة النوم/).closest('li') as HTMLElement;
    expect(within(none).queryByRole('button')).toBeNull();
    expect(none.textContent).toContain('لا محطة مفتوحة');
  });

  it('a pick asks for a draft and fills the form from it', async () => {
    serve({ 'POST /v1/goals/{ref}/to-habit': () => json(draft()) });
    await openPicker();
    fireEvent.click(await screen.findByRole('button', { name: /O7.*اختبار المستوى/ }));
    await waitFor(() => expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('اختبار المستوى'));
    const call = calls.find((c) => c.path === '/v1/goals/ms-7/to-habit');
    expect(call?.method).toBe('POST');
    expect(screen.getByRole('radio', { name: 'مدة' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('الهدف في الفترة') as HTMLInputElement).value).toBe('120');
    expect(screen.getByRole('radio', { name: 'أسبوعية' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/يخدم/).textContent).toContain('O7');
  });

  it('saves the habit linked to the goal', async () => {
    serve({
      'POST /v1/goals/{ref}/to-habit': () => json(draft()),
      'POST /v1/habits': () => json(stored({ code: 'u_g' }), 201),
    });
    await openPicker();
    fireEvent.click(await screen.findByRole('button', { name: /O7.*اختبار المستوى/ }));
    await waitFor(() => expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('اختبار المستوى'));
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_g/ });
    expect(sent('POST', '/v1/habits')[0]?.body).toMatchObject({ goal_ref: 'ms-7', outcome: 'O7' });
  });

  it('going back to «حرة» unlinks the goal', async () => {
    serve({ 'POST /v1/goals/{ref}/to-habit': () => json(draft()), 'POST /v1/habits': () => json(stored({ code: 'u_f' }), 201) });
    await openPicker();
    fireEvent.click(await screen.findByRole('button', { name: /قراءة كتاب/ }));
    await waitFor(() => expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('اختبار المستوى'));
    choose('المصدر', 'حرة');
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_f/ });
    expect(sent('POST', '/v1/habits')[0]?.body).toMatchObject({ goal_ref: null, outcome: null });
  });

  it('draws loading, empty, error and offline', async () => {
    // loading: the skeleton and a busy frame while the overview is on its way
    serve({ 'GET /v1/overview': () => new Promise<Response>(() => undefined) });
    await openPicker();
    expect(await screen.findByRole('status')).toBeTruthy();
    cleanup();
    resetDb();

    // empty: nothing in the mirror yet
    serve({ 'GET /v1/overview': () => json({ outcomes: [], cards: [] }) });
    await openPicker();
    expect(await screen.findByText(/لا أهداف بعد/)).toBeTruthy();
    cleanup();
    resetDb();

    // error
    serve({ 'GET /v1/overview': () => json({ detail: 'x' }, 500) });
    await openPicker();
    expect(await screen.findByText('تعذّر التحميل')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
    cleanup();
    resetDb();

    // offline with no saved copy
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (new URL((input as Request).url).pathname === '/v1/overview') throw new TypeError('Failed to fetch');
      return json([]);
    });
    await openPicker();
    expect(await screen.findByText('لا نسخة محفوظة بعد')).toBeTruthy();
  });

  it('a draft that cannot be had says so and keeps the form', async () => {
    serve({ 'POST /v1/goals/{ref}/to-habit': () => json({ detail: 'لا محطة ولا بطاقة بهذا المعرّف' }, 404) });
    await openPicker();
    type('العنوان', 'كتبتها');
    fireEvent.click(await screen.findByRole('button', { name: /قراءة كتاب/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('تعذّر اقتراح العادة');
    expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('كتبتها');
  });
});

describe('a link without a goal (the home page): ?source=goal', () => {
  it('opens on the «من هدف» source with the list of goals, and asks for no draft yet', async () => {
    serve({});
    mount('/habits/new?source=goal');
    await screen.findByRole('heading', { level: 1, name: 'عادة جديدة' });
    expect(screen.getByRole('radio', { name: 'من هدف' }).getAttribute('aria-checked')).toBe('true');
    expect(await screen.findByRole('list', { name: 'الأهداف' })).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/to-habit'))).toBe(false);
  });

  it('a link without that word opens on the free source, as before', async () => {
    serve({});
    mount('/habits/new');
    await screen.findByRole('heading', { level: 1, name: 'عادة جديدة' });
    expect(screen.getByRole('radio', { name: 'حرة' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('a draft from a link (the goal page): the owner rulings of D-067 item 5', () => {
  it('a nights indicator opens as a yes/no habit with a weekly target of 5 (M-4)', async () => {
    serve({
      'POST /v1/goals/{ref}/to-habit': () =>
        json(draft({ title_ar: 'نوم 7 ساعات', goal_ref: 'ms-sleep', outcome: 'O3', kind: 'boolean', unit: '', target_per_period: 5, period: 'week' })),
    });
    mount('/habits/new?goal=ms-sleep&kpi=sleep_7h_nights&period=week');
    await waitFor(() => expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('نوم 7 ساعات'));
    const call = calls.find((c) => c.path === '/v1/goals/ms-sleep/to-habit');
    expect(call?.body).toEqual({ kpi_code: 'sleep_7h_nights', period: 'week' });
    expect(screen.getByRole('radio', { name: 'نعم أو لا' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'أسبوعية' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('الهدف في الفترة') as HTMLInputElement).value).toBe('5');
    expect(screen.getByRole('region', { name: 'ملخص العادة' }).textContent).toContain(`المطلوب أسبوعياً: ${fmt.count(5, 'day')}`);
  });

  it('books read are a habit of the year: it ends on 31 December, not at the end of the plan (M-5)', async () => {
    serve({
      'POST /v1/goals/{ref}/to-habit': () =>
        json(draft({ title_ar: 'قراءة الكتب', goal_ref: 'ms-books', outcome: 'O7', kind: 'count', unit: '', target_per_period: 2, period: 'week' })),
    });
    mount('/habits/new?goal=ms-books&kpi=books_done&period=week');
    await waitFor(() => expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('قراءة الكتب'));
    expect((screen.getByLabelText('إلى') as HTMLInputElement).value).toBe('2026-12-31');
    expect(screen.getByRole('radio', { name: 'مخصص' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('region', { name: 'ملخص العادة' }).textContent).toContain(`تنتهي في ${fmt.day('2026-12-31')}`);
  });

  it('a draft that arrives late does not overwrite what was typed meanwhile (M-2)', async () => {
    let release: () => void = () => undefined;
    serve({
      'POST /v1/goals/{ref}/to-habit': () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(draft({ title_ar: 'عنوان المحطة', target_per_period: 120 })));
        }),
    });
    mount('/habits/new?goal=ms-7');
    await screen.findByRole('heading', { level: 1, name: 'عادة جديدة' });
    type('العنوان', 'كتبتها بنفسي');
    release();
    await waitFor(() => expect((screen.getByLabelText('الهدف في الفترة') as HTMLInputElement).value).toBe('120'));
    // The fields the person did not touch come from the draft; the typed one stays.
    expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('كتبتها بنفسي');
    expect(screen.getByRole('radio', { name: 'مدة' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('region', { name: 'ملخص العادة' }).textContent).toContain('يخدم المخرج O7');
  });

  it('another indicator keeps the draft as the server made it', async () => {
    serve({ 'POST /v1/goals/{ref}/to-habit': () => json(draft({ title_ar: 'ورش', kind: 'count', unit: '', target_per_period: 1 })) });
    mount('/habits/new?goal=ms-7&kpi=workshops_count');
    await waitFor(() => expect((screen.getByLabelText('العنوان') as HTMLInputElement).value).toBe('ورش'));
    expect((screen.getByLabelText('إلى') as HTMLInputElement).value).toBe('');
  });
});

describe('reminders and the schedule', () => {
  it('adds up to three reminders and sends them whole', async () => {
    serve({ 'POST /v1/habits': () => json(stored({ code: 'u_r' }), 201) });
    await openNew();
    type('العنوان', 'قراءة');
    const add = screen.getByRole('button', { name: 'إضافة تذكير' }) as HTMLButtonElement;
    fireEvent.click(add);
    fireEvent.input(screen.getByLabelText('وقت التذكير 1'), { target: { value: '07:30' } });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(add.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'حذف التذكير 3' }));
    expect(add.disabled).toBe(false);
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_r/ });
    expect((sent('POST', '/v1/habits')[0]?.body as { reminders: unknown[] }).reminders).toEqual([
      { time: '07:30', days_mask: 127 },
      { time: '07:00', days_mask: 127 },
    ]);
  });

  it('chooses days of the week for a daily habit', async () => {
    serve({ 'POST /v1/habits': () => json(stored({ code: 'u_w' }), 201) });
    await openNew();
    type('العنوان', 'مشي');
    choose('الجدول', 'أيام محددة');
    fireEvent.click(screen.getByRole('button', { name: 'الأحد' }));
    fireEvent.click(screen.getByRole('button', { name: 'الثلاثاء' }));
    fireEvent.click(saveButton());
    await screen.findByRole('heading', { level: 1, name: /تفاصيل u_w/ });
    expect(sent('POST', '/v1/habits')[0]?.body).toMatchObject({ schedule_kind: 'weekdays', weekday_mask: 0b0000101 });
  });

  it('a weekly habit has no schedule choice', async () => {
    await openNew();
    choose('الفترة', 'أسبوعية');
    expect(screen.queryByRole('radiogroup', { name: 'الجدول' })).toBeNull();
  });

  it('asks for at least one weekday as a field error when none is chosen', async () => {
    await openNew();
    type('العنوان', 'مشي');
    choose('الجدول', 'أيام محددة');
    fireEvent.click(saveButton());
    expect(await screen.findByText(/يوماً واحداً على الأقل/)).toBeTruthy();
  });
});
