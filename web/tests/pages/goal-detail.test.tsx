// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fmt, setDigits } from '../../src/lib/format';
import GoalDetailPage from '../../src/pages/goals/detail';
import { clearOutbox, closeDb, listPending } from '../../src/sync/outbox';
import { NOON_RIYADH } from '../helpers/goals-fixtures';
import { habit } from '../helpers/today-fixtures';
import {
  detailGoals,
  edit,
  HABITS,
  PACE,
  type Server,
  type ServeOptions,
  serve,
  TASKS,
  task,
} from '../helpers/goal-detail-fixtures';

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

let fetchMock: ReturnType<typeof vi.fn>;
let server: Server;

const setOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
};

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
  setOnline(true);
  await clearOutbox().catch(() => undefined);
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

/** Opens `/goals/<ref>` and waits for the page's heading. */
async function open(ref = 'O1', options: ServeOptions = {}, heading: string | RegExp = /الصحة الجسدية/) {
  history.replaceState(null, '', `/goals/${ref}`);
  server = serve(fetchMock, options);
  const view = render(
    <LocationProvider>
      <GoalDetailPage params={{ ref }} />
    </LocationProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: heading });
  return view;
}

const rowOf = (container: Element, id: string): HTMLElement =>
  container.querySelector(`[data-milestone="${id}"]`) as HTMLElement;

async function changeDate(row: HTMLElement, value: string): Promise<void> {
  fireEvent.click(within(row).getByRole('button', { name: /^تعديل الموعد/ }));
  fireEvent.input(within(row).getByLabelText('الموعد'), { target: { value } });
  fireEvent.click(within(row).getByRole('button', { name: 'حفظ' }));
}

describe('goal detail: the outcome page', () => {
  it('names the outcome, its milestones and the sections of design 4', async () => {
    const { container } = await open();
    expect(screen.getByRole('heading', { level: 2, name: 'المحطات' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'العادات المرتبطة' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'المهام' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'سجل التعديلات' })).toBeTruthy();
    for (const id of ['m-done-1', 'm-late', 'm-blood']) expect(rowOf(container, id)).toBeTruthy();
    expect(container.querySelectorAll('[data-milestone]')).toHaveLength(3);
  });

  it('has no delete button anywhere on the page', async () => {
    await open();
    expect(screen.queryByRole('button', { name: /حذف/ })).toBeNull();
    expect(screen.queryByText(/حذف/)).toBeNull();
  });

  it('draws the pace line the server sent, with its numbers in the label', async () => {
    await open('O1', { pace: PACE });
    const chart = await screen.findByRole('img', { name: /القيمة 2/ });
    expect(chart.getAttribute('aria-label')).toContain('المتوقع اليوم 3');
    expect(chart.getAttribute('aria-label')).toContain('45 يوماً');
    expect(server.called('GET', '/v1/goals/O1/pace')).toHaveLength(1);
  });

  it('says «دون الوتيرة» only when the server says the pace is missed, and «على الوتيرة» only when met', async () => {
    const { unmount } = await open('O1', { pace: PACE });
    await screen.findByRole('img', { name: /القيمة 2/ });
    expect(screen.getByText('دون الوتيرة المتوقعة')).toBeTruthy();
    expect(screen.queryByText('على الوتيرة')).toBeNull();
    unmount();
    await open('O1', { pace: { ...PACE, current_value: 5, on_pace: true } });
    await screen.findByRole('img', { name: /القيمة 5/ });
    expect(screen.getByText('على الوتيرة')).toBeTruthy();
  });

  it('never says «على الوتيرة» for a goal with nothing to measure (on_pace null)', async () => {
    await open('O1', {
      pace: { ...PACE, current_value: null, on_pace: null, projected_end: null, readings: [] },
    });
    await screen.findByRole('img', { name: /لا قراءة بعد/ });
    expect(screen.queryByText('على الوتيرة')).toBeNull();
    expect(screen.queryByText('دون الوتيرة المتوقعة')).toBeNull();
  });

  it('shows no pace section when the server has no pace for it (404)', async () => {
    await open('O1', { pace: 404 });
    await waitFor(() => expect(server.called('GET', '/v1/goals/O1/pace')).toHaveLength(1));
    expect(screen.queryByRole('img', { name: /القيمة/ })).toBeNull();
  });

  it('leaves the place of the indicator card in the head empty (task 17)', async () => {
    const { container } = await open();
    expect(container.querySelector('[data-slot="indicator"]')).toBeNull();
  });
});

describe('goal detail: editing a milestone', () => {
  it('a new due date calls PATCH once with only due_date, and the row shows it with «معلّق»', async () => {
    const { container } = await open();
    const row = rowOf(container, 'm-late');
    await changeDate(row, '2026-11-14');
    await waitFor(() => expect(within(row).getByText('معلّق')).toBeTruthy());
    const patches = server.called('PATCH', '/v1/milestones/m-late');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ due_date: '2026-11-14' });
    expect(within(row).getByText(fmt.day('2026-11-14'))).toBeTruthy();
    // the other rows carry no badge
    expect(within(rowOf(container, 'm-blood')).queryByText('معلّق')).toBeNull();
  });

  it('keeps the edit open with the server words when the server refuses the date (422)', async () => {
    const { container } = await open('O1', {
      patchStatus: 422,
      patchBody: { detail: 'طلب غير صالح', errors: [{ loc: ['body', 'due_date'], type: 'due_date_out_of_range' }] },
    });
    const row = rowOf(container, 'm-late');
    await changeDate(row, '2027-01-01');
    const alert = await within(row).findByRole('alert');
    expect(alert.textContent).toContain('خارج مدى الخطة');
    expect((within(row).getByLabelText('الموعد') as HTMLInputElement).value).toBe('2027-01-01');
    expect(within(row).queryByText('معلّق')).toBeNull();
  });

  it('a date outside the plan is refused at once, in Arabic, and nothing is sent', async () => {
    const { container } = await open();
    const row = rowOf(container, 'm-late');
    await changeDate(row, '2032-01-01');
    const alert = await within(row).findByRole('alert');
    expect(alert.textContent).toContain('خارج مدى الخطة');
    expect(server.called('PATCH', /milestones/)).toHaveLength(0);
    expect((within(row).getByLabelText('الموعد') as HTMLInputElement).value).toBe('2032-01-01');
  });

  it('marking a milestone done calls PATCH once with done: true', async () => {
    const { container } = await open();
    const row = rowOf(container, 'm-blood');
    fireEvent.click(within(row).getByRole('checkbox', { name: /^منجزة/ }));
    await waitFor(() => expect(server.called('PATCH', '/v1/milestones/m-blood')).toHaveLength(1));
    expect(server.called('PATCH', '/v1/milestones/m-blood')[0]?.body).toEqual({ done: true });
    await waitFor(() => expect(within(row).getByText('معلّق')).toBeTruthy());
    expect((within(row).getByRole('checkbox', { name: /^منجزة/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('saves the evidence text with PATCH evidence', async () => {
    const { container } = await open();
    const row = rowOf(container, 'm-blood');
    fireEvent.click(within(row).getByRole('button', { name: /^تعديل الدليل/ }));
    fireEvent.input(within(row).getByLabelText('الدليل'), { target: { value: 'نتيجة جديدة' } });
    fireEvent.click(within(row).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(server.called('PATCH', '/v1/milestones/m-blood')).toHaveLength(1));
    expect(server.called('PATCH', '/v1/milestones/m-blood')[0]?.body).toEqual({ evidence: 'نتيجة جديدة' });
  });

  it('cancelling the edit field sends nothing', async () => {
    const { container } = await open();
    const row = rowOf(container, 'm-late');
    fireEvent.click(within(row).getByRole('button', { name: /^تعديل الموعد/ }));
    fireEvent.click(within(row).getByRole('button', { name: 'إلغاء' }));
    expect(server.called('PATCH', /milestones/)).toHaveLength(0);
    expect(within(row).queryByLabelText('الموعد')).toBeNull();
  });

  it('without a connection every edit control is disabled and says «يحتاج اتصالاً»', async () => {
    setOnline(false);
    const { container } = await open();
    const row = rowOf(container, 'm-late');
    for (const button of within(row).getAllByRole('button', { name: /^تعديل/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    for (const box of within(row).getAllByRole('checkbox')) expect((box as HTMLInputElement).disabled).toBe(true);
    expect(within(row).getAllByText('يحتاج اتصالاً').length).toBeGreaterThan(0);
  });

  it('a late open milestone says how many days late', async () => {
    const { container } = await open();
    expect(within(rowOf(container, 'm-late')).getByText('متأخرة يومين')).toBeTruthy();
    expect(within(rowOf(container, 'm-blood')).queryByText(/متأخرة/)).toBeNull();
  });
});

describe('goal detail: the edit log', () => {
  const six = [
    edit(1, { status: 'pending' }),
    edit(2, { status: 'applied', applied_at: '2026-11-10T09:00:00Z', field: 'evidence', old_value: null, new_value: 'نص' }),
    edit(3, { status: 'conflict', field: 'done', old_value: false, new_value: true, page_id: 'm-blood' }),
    edit(4, { status: 'failed', error: 'x', field: 'done', old_value: false, new_value: true }),
    edit(5, { status: 'superseded' }),
    edit(6, { status: 'cancelled' }),
  ];
  const logOf = (): HTMLElement => screen.getByRole('region', { name: 'سجل التعديلات' });
  const entry = (id: string): HTMLElement => logOf().querySelector(`[data-edit="${id}"]`) as HTMLElement;

  it('shows every one of the six states in words, with from and to', async () => {
    await open('O1', { edits: six });
    await within(logOf()).findAllByRole('listitem');
    const words: Record<number, string> = {
      1: 'معلّق',
      2: 'طُبّق على Notion',
      3: 'متعارض مع Notion',
      4: 'تعذّر التطبيق على Notion',
      5: 'أُزيح بتعديل أحدث',
      6: 'ملغى',
    };
    for (const [n, word] of Object.entries(words)) {
      const row = entry(`11111111-1111-4111-8111-11111111111${n}`);
      expect(within(row).getByText(word), `state ${n}`).toBeTruthy();
    }
    expect(within(entry('11111111-1111-4111-8111-111111111114')).getByText('لم يُطبَّق؛ يمكن تعديل الحقل من جديد')).toBeTruthy();
    const first = entry('11111111-1111-4111-8111-111111111111');
    expect(first.textContent).toContain('من');
    expect(first.textContent).toContain('2026-11-08');
    expect(first.textContent).toContain('إلى');
    expect(first.textContent).toContain('2026-11-14');
    expect(first.textContent).toContain('قياس خط الأساس');
  });

  it('offers «إلغاء» on a pending edit and on a conflicting one, and on no other', async () => {
    await open('O1', { edits: six });
    await within(logOf()).findAllByRole('listitem');
    const cancels = within(logOf())
      .getAllByRole('button', { name: /^إلغاء/ })
      .map((b) => b.closest('[data-edit]')?.getAttribute('data-edit'));
    expect(cancels.sort()).toEqual(
      ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111113'].sort(),
    );
  });

  it('offers «إعادة التعديل» on a conflict only', async () => {
    await open('O1', { edits: six });
    await within(logOf()).findAllByRole('listitem');
    const again = within(logOf()).getAllByRole('button', { name: /^إعادة التعديل/ });
    expect(again).toHaveLength(1);
    expect(again[0]?.closest('[data-edit]')?.getAttribute('data-edit')).toBe('11111111-1111-4111-8111-111111111113');
  });

  it('«إعادة التعديل» calls PATCH once with the same value', async () => {
    await open('O1', { edits: [edit(3, { status: 'conflict', field: 'done', old_value: false, new_value: true, page_id: 'm-blood' })] });
    await within(logOf()).findAllByRole('listitem');
    fireEvent.click(within(logOf()).getByRole('button', { name: /^إعادة التعديل/ }));
    await waitFor(() => expect(server.called('PATCH', '/v1/milestones/m-blood')).toHaveLength(1));
    expect(server.called('PATCH', '/v1/milestones/m-blood')[0]?.body).toEqual({ done: true });
    expect(server.called('POST', /cancel/)).toHaveLength(0);
  });

  it('once a newer edit of the same field exists, the conflict row has no buttons left', async () => {
    await open('O1', {
      edits: [
        edit(3, { status: 'conflict', field: 'done', old_value: false, new_value: true, page_id: 'm-blood' }),
        edit(7, {
          status: 'pending',
          field: 'done',
          old_value: false,
          new_value: true,
          page_id: 'm-blood',
          created_at: '2026-11-10T09:30:00Z',
        }),
      ],
    });
    await within(logOf()).findAllByRole('listitem');
    const old = entry('11111111-1111-4111-8111-111111111113');
    expect(within(old).getByText('متعارض مع Notion')).toBeTruthy();
    expect(within(old).queryByRole('button')).toBeNull();
    expect(within(entry('11111111-1111-4111-8111-111111111117')).getByRole('button', { name: /^إلغاء/ })).toBeTruthy();
  });

  it('«إلغاء» of a conflict calls the cancel route, then the row says «ملغى»', async () => {
    await open('O1', { edits: [edit(3, { status: 'conflict', field: 'done', old_value: false, new_value: true, page_id: 'm-blood' })] });
    await within(logOf()).findAllByRole('listitem');
    fireEvent.click(within(logOf()).getByRole('button', { name: /^إلغاء/ }));
    await waitFor(() => expect(within(logOf()).getByText('ملغى')).toBeTruthy());
    const posts = server.called('POST', '/v1/goal-edits/11111111-1111-4111-8111-111111111113/cancel');
    expect(posts).toHaveLength(1);
    expect(server.called('PATCH', /milestones/)).toHaveLength(0);
    expect(within(logOf()).queryByRole('button')).toBeNull();
  });

  it('an applied edit the mirror has not caught up with shows its new value and no «معلّق» badge', async () => {
    const goals = detailGoals();
    // the server shows the applied value (rule 2 of design 11) and lists nothing as pending
    goals.milestones = goals.milestones.map((m) => (m.page_id === 'm-late' ? { ...m, due_date: '2026-11-14', pending: [] } : m));
    const { container } = await open('O1', {
      goals,
      edits: [edit(1, { status: 'applied', applied_at: '2026-11-10T09:00:00Z' })],
    });
    const row = rowOf(container, 'm-late');
    expect(within(row).getByText(fmt.day('2026-11-14'))).toBeTruthy();
    await within(logOf()).findAllByRole('listitem');
    expect(within(row).queryByText('معلّق')).toBeNull();
    expect(screen.queryByText('معلّق')).toBeNull();
    expect(within(logOf()).getByText('طُبّق على Notion')).toBeTruthy();
  });

  it('lists only the edits of this goal', async () => {
    await open('O1', { edits: [edit(1), edit(2, { page_id: 'someone-else' })] });
    await within(logOf()).findAllByRole('listitem');
    expect(logOf().querySelectorAll('[data-edit]')).toHaveLength(1);
  });

  it('says there are no edits yet when there are none', async () => {
    await open('O1', { edits: [] });
    expect(await within(logOf()).findByText('لا تعديلات بعد.')).toBeTruthy();
  });
});

describe('goal detail: linked habits', () => {
  const linked = (): HTMLElement => screen.getByRole('region', { name: 'العادات المرتبطة' });

  it('lists the habits of the outcome with their total repetitions', async () => {
    await open();
    const section = linked();
    await within(section).findByRole('link', { name: 'تمارين الضغط' });
    expect(within(section).getByRole('link', { name: 'تمارين الضغط' }).getAttribute('href')).toBe('/habits/pushups');
    expect(section.textContent).toContain('12 مرة');
    expect(section.textContent).toContain('1 مرة');
  });

  it('«+» on a count habit with 2 today adds one event with value 3', async () => {
    await open();
    const button = await within(linked()).findByRole('button', { name: /^\+1 مرة · تمارين الضغط/ });
    await waitFor(() => expect(within(linked()).getByText(/اليوم 2/)).toBeTruthy());
    fireEvent.click(button);
    await waitFor(async () => expect((await listPending()).filter((e) => e.type === 'habit_logged')).toHaveLength(1));
    const [event] = (await listPending()).filter((e) => e.type === 'habit_logged');
    expect(event?.payload).toMatchObject({ habit_code: 'pushups', status: 'done', value: 3 });
  });

  it('«+» on a yes-or-no habit logs it done', async () => {
    await open();
    const button = await within(linked()).findByRole('button', { name: /^تسجيل · المشي/ });
    fireEvent.click(button);
    await waitFor(async () => expect((await listPending()).filter((e) => e.type === 'habit_logged')).toHaveLength(1));
    const [event] = await listPending();
    expect(event?.payload).toEqual({ habit_code: 'walk_o1', status: 'done' });
  });

  it('after a tap the page says what was logged and offers «تراجع», which takes the event back', async () => {
    await open();
    fireEvent.click(await within(linked()).findByRole('button', { name: /^\+1 مرة · تمارين الضغط/ }));
    const undo = await screen.findByRole('button', { name: 'تراجع' });
    fireEvent.click(undo);
    await waitFor(async () => expect(await listPending()).toHaveLength(0));
  });

  it('«عادة من هذا الهدف» opens the habit editor for the next milestone with the pace indicator', async () => {
    await open('O1', { pace: PACE });
    await screen.findByRole('img', { name: /القيمة 2/ });
    const link = screen.getByRole('link', { name: 'عادة من هذا الهدف' });
    expect(link.getAttribute('href')).toBe('/habits/new?goal=m-late&kpi=books_done&period=week');
    expect(link.className).toContain('btn-primary');
  });

  it('the same link has no kpi when the pace has none', async () => {
    await open('O1', { pace: 404 });
    await waitFor(() => expect(server.called('GET', '/v1/goals/O1/pace')).toHaveLength(1));
    const link = screen.getByRole('link', { name: 'عادة من هذا الهدف' });
    expect(link.getAttribute('href')).toBe('/habits/new?goal=m-late');
  });

  it('an outcome with no open milestone cannot start a habit and says why', async () => {
    const goals = detailGoals();
    goals.outcomes = goals.outcomes.map((o) => (o.code === 'O1' ? { ...o, next_milestone: null } : o));
    goals.cards = [];
    await open('O1', { goals });
    expect(screen.queryByRole('link', { name: 'عادة من هذا الهدف' })).toBeNull();
    expect(screen.getByText('لا محطة مفتوحة ولا بطاقة لبدء عادة منها')).toBeTruthy();
  });

  it('an outcome with no open milestone but a card starts the habit from the card (M-8)', async () => {
    const goals = detailGoals();
    goals.outcomes = goals.outcomes.map((o) => (o.code === 'O1' ? { ...o, next_milestone: null } : o));
    await open('O1', { goals });
    expect(screen.getByRole('link', { name: 'عادة من هذا الهدف' }).getAttribute('href')).toBe('/habits/new?goal=c-health');
    expect(screen.queryByText(/لا محطة مفتوحة/)).toBeNull();
  });

  it('«بدء تركيز» goes to /focus?goal=<ref>', async () => {
    await open();
    expect(screen.getByRole('link', { name: 'بدء تركيز' }).getAttribute('href')).toBe('/focus?goal=O1');
  });

  it('«إضافة عادة» in the section links to the same editor draft', async () => {
    await open('O1', { pace: 404 });
    const link = within(linked()).getByRole('link', { name: 'إضافة عادة' });
    expect(link.getAttribute('href')).toBe('/habits/new?goal=m-late');
  });
});

describe('goal detail: one source for every number (I-2)', () => {
  const doneBox = (container: Element) => within(rowOf(container, 'm-blood')).getByRole('checkbox', { name: /^منجزة/ });

  it('ticking a milestone done reads the plan and the pace again, and the summary and the pace show the new count', async () => {
    const { container } = await open('O1', { pace: PACE });
    await screen.findByRole('img', { name: /القيمة 2/ });
    expect(screen.getByText(/1 من 3 محطة/)).toBeTruthy();
    server.pace = { ...PACE, current_value: 3, on_pace: true };
    fireEvent.click(doneBox(container));
    await screen.findByRole('img', { name: /القيمة 3/ });
    expect(await screen.findByText(/2 من 3 محطة/)).toBeTruthy();
    expect(screen.getByText('على الوتيرة')).toBeTruthy();
    expect(server.called('GET', '/v1/goals')).toHaveLength(2);
    expect(server.called('GET', '/v1/goals/O1/pace')).toHaveLength(2);
  });

  it('a new due date reads them again too', async () => {
    const { container } = await open('O1', { pace: PACE });
    await screen.findByRole('img', { name: /القيمة 2/ });
    await changeDate(rowOf(container, 'm-late'), '2026-11-14');
    await waitFor(() => expect(server.called('GET', '/v1/goals/O1/pace')).toHaveLength(2));
    expect(server.called('GET', '/v1/goals')).toHaveLength(2);
  });

  it('«إعادة التعديل» reads the plan and the pace again', async () => {
    await open('O1', {
      pace: PACE,
      edits: [edit(3, { status: 'conflict', field: 'done', old_value: false, new_value: true, page_id: 'm-blood' })],
    });
    await screen.findByRole('img', { name: /القيمة 2/ });
    const log = screen.getByRole('region', { name: 'سجل التعديلات' });
    await within(log).findAllByRole('listitem');
    fireEvent.click(within(log).getByRole('button', { name: /^إعادة التعديل/ }));
    await waitFor(() => expect(server.called('GET', '/v1/goals/O1/pace')).toHaveLength(2));
    expect(server.called('GET', '/v1/goals')).toHaveLength(2);
  });

  it('«إلغاء» reads the pace again with the plan, so the pace goes back with the summary', async () => {
    await open('O1', { pace: PACE, edits: [edit(1, { status: 'pending' })] });
    await screen.findByRole('img', { name: /القيمة 2/ });
    const log = screen.getByRole('region', { name: 'سجل التعديلات' });
    await within(log).findAllByRole('listitem');
    server.pace = { ...PACE, current_value: 1 };
    fireEvent.click(within(log).getByRole('button', { name: /^إلغاء/ }));
    await screen.findByRole('img', { name: /القيمة 1/ });
    expect(server.called('GET', '/v1/goals')).toHaveLength(2);
  });
});

describe('goal detail: tasks', () => {
  const tasks = (): HTMLElement => screen.getByRole('region', { name: 'المهام' });

  it('counts the done tasks of all: «2 من 5»', async () => {
    await open();
    expect(await within(tasks()).findByText('2 من 5')).toBeTruthy();
    expect(server.called('GET', '/v1/goals/O1/tasks')).toHaveLength(1);
  });

  it('ticking a task adds one goal_task_set event and the counter becomes «3 من 5» before the network', async () => {
    await open();
    await within(tasks()).findByText('2 من 5');
    fireEvent.click(within(tasks()).getByRole('button', { name: /مهمة 3/ }));
    expect(await within(tasks()).findByText('3 من 5')).toBeTruthy();
    await waitFor(async () => expect((await listPending()).filter((e) => e.type === 'goal_task_set')).toHaveLength(1));
    const [event] = await listPending();
    expect(event?.payload).toEqual({ task_id: TASKS[2]?.id, done: true });
    // nothing was sent to the server: the outbox holds it
    expect(server.called('PATCH', /goal-tasks/)).toHaveLength(0);
  });

  it('ticking a done task again takes it back (a second event, the counter goes down)', async () => {
    await open();
    await within(tasks()).findByText('2 من 5');
    fireEvent.click(within(tasks()).getByRole('button', { name: /مهمة 1/ }));
    expect(await within(tasks()).findByText('1 من 5')).toBeTruthy();
    const [event] = await listPending();
    expect(event?.payload).toEqual({ task_id: TASKS[0]?.id, done: false });
  });

  it('adding a task calls POST once with its title, and the list and the counter grow', async () => {
    await open();
    await within(tasks()).findByText('2 من 5');
    fireEvent.input(within(tasks()).getByLabelText('عنوان المهمة'), { target: { value: 'حجز الموعد' } });
    fireEvent.click(within(tasks()).getByRole('button', { name: 'إضافة مهمة' }));
    await waitFor(() => expect(server.called('POST', '/v1/goals/O1/tasks')).toHaveLength(1));
    expect(server.called('POST', '/v1/goals/O1/tasks')[0]?.body).toEqual({ title: 'حجز الموعد' });
    expect(await within(tasks()).findByText('2 من 6')).toBeTruthy();
    expect(within(tasks()).getByRole('button', { name: /حجز الموعد/ })).toBeTruthy();
    expect((within(tasks()).getByLabelText('عنوان المهمة') as HTMLInputElement).value).toBe('');
  });

  it('adding needs a title: an empty one sends nothing', async () => {
    await open();
    await within(tasks()).findByText('2 من 5');
    fireEvent.click(within(tasks()).getByRole('button', { name: 'إضافة مهمة' }));
    expect(server.called('POST', /tasks/)).toHaveLength(0);
  });

  it('without a connection adding is disabled and says «يحتاج اتصالاً», while ticking still works', async () => {
    setOnline(false);
    await open();
    await within(tasks()).findByText('2 من 5');
    expect((within(tasks()).getByRole('button', { name: 'إضافة مهمة' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(tasks()).getByText('يحتاج اتصالاً')).toBeTruthy();
    fireEvent.click(within(tasks()).getByRole('button', { name: /مهمة 3/ }));
    expect(await within(tasks()).findByText('3 من 5')).toBeTruthy();
  });

  it('a task still in the outbox from before shows as done after a reload of the page', async () => {
    const { enqueue } = await import('../../src/sync/outbox');
    await enqueue('goal_task_set', { task_id: task(4, false).id, done: true });
    await open();
    expect(await within(tasks()).findByText('3 من 5')).toBeTruthy();
  });

  it('says there are no tasks yet for a goal with none', async () => {
    await open('O1', { tasks: [] });
    expect(await within(tasks()).findByText('لا مهام بعد.')).toBeTruthy();
  });
});

describe('goal detail: a card and a milestone', () => {
  it('a card page edits its status with PATCH /v1/cards, from the statuses the plan already has', async () => {
    await open('c-health', {}, 'خطة اللياقة');
    const select = (await screen.findByLabelText('الحالة')) as HTMLSelectElement;
    expect(select.value).toBe('قيد التنفيذ');
    expect(Array.from(select.options).map((o) => o.value).sort()).toEqual(['قيد التنفيذ', 'مخطط'].sort());
    fireEvent.change(select, { target: { value: 'مخطط' } });
    await waitFor(() => expect(server.called('PATCH', '/v1/cards/c-health')).toHaveLength(1));
    expect(server.called('PATCH', '/v1/cards/c-health')[0]?.body).toEqual({ status: 'مخطط' });
    await waitFor(() => expect(screen.getAllByText('معلّق').length).toBeGreaterThan(0));
  });

  it('a card page shows the target date and the next step as they are (read only) and its milestones', async () => {
    const { container } = await open('c-health', {}, 'خطة اللياقة');
    expect(await screen.findByText('حجز موعد الفحص')).toBeTruthy();
    expect(screen.getByText(fmt.day('2026-12-31'))).toBeTruthy();
    expect(rowOf(container, 'm-blood')).toBeTruthy();
    expect(server.called('GET', /pace/)).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'عادة من هذا الهدف' }).getAttribute('href')).toBe('/habits/new?goal=c-health');
    expect(screen.getByRole('link', { name: 'بدء تركيز' }).getAttribute('href')).toBe('/focus?goal=c-health');
  });

  it('a milestone page lists the habits made from that milestone (M-7)', async () => {
    const made = habit('blood_follow', 'متابعة الفحص', { goal_ref: 'm-blood' });
    await open('m-blood', { habits: [...HABITS, made] }, 'فحص الدم السنوي');
    const section = screen.getByRole('region', { name: 'العادات المرتبطة' });
    expect(await within(section).findByRole('link', { name: 'متابعة الفحص' })).toBeTruthy();
    expect(within(section).queryByRole('link', { name: 'تمارين الضغط' })).toBeNull();
    expect(within(section).queryByText('لا عادات مرتبطة بهذا الهدف.')).toBeNull();
  });

  it('a milestone page edits that milestone and links back to its outcome', async () => {
    const { container } = await open('m-blood', {}, 'فحص الدم السنوي');
    await changeDate(rowOf(container, 'm-blood'), '2026-11-20');
    await waitFor(() => expect(server.called('PATCH', '/v1/milestones/m-blood')).toHaveLength(1));
    expect(screen.getByRole('link', { name: /الصحة الجسدية/ }).getAttribute('href')).toBe('/goals/O1');
    expect(screen.getByRole('link', { name: 'عادة من هذا الهدف' }).getAttribute('href')).toBe('/habits/new?goal=m-blood');
  });
});

describe('goal detail: the four states', () => {
  it('loading: a skeleton with aria-busy', async () => {
    history.replaceState(null, '', '/goals/O1');
    server = serve(fetchMock);
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    const { container } = render(
      <LocationProvider>
        <GoalDetailPage params={{ ref: 'O1' }} />
      </LocationProvider>,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('empty: a reference the plan does not know says so and links back to the goals', async () => {
    history.replaceState(null, '', '/goals/nope');
    server = serve(fetchMock);
    render(
      <LocationProvider>
        <GoalDetailPage params={{ ref: 'nope' }} />
      </LocationProvider>,
    );
    expect(await screen.findByText('لا هدف بهذا المعرّف.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'الأهداف' }).getAttribute('href')).toBe('/goals');
  });

  it('error: «تعذّر التحميل» with «إعادة المحاولة», and no raw error', async () => {
    history.replaceState(null, '', '/goals/O1');
    server = serve(fetchMock, { fail: 500 });
    render(
      <LocationProvider>
        <GoalDetailPage params={{ ref: 'O1' }} />
      </LocationProvider>,
    );
    expect(await screen.findByText('تعذّر التحميل')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });

  it('offline with no saved copy: «لا نسخة محفوظة بعد»', async () => {
    history.replaceState(null, '', '/goals/O1');
    server = serve(fetchMock, { fail: 'network' });
    render(
      <LocationProvider>
        <GoalDetailPage params={{ ref: 'O1' }} />
      </LocationProvider>,
    );
    expect(await screen.findByText('لا نسخة محفوظة بعد')).toBeTruthy();
  });

  it('offline with a saved copy: the copy with its badge, edits disabled', async () => {
    const { writeCache } = await import('../../src/data/cache');
    await writeCache('goals', detailGoals());
    setOnline(false);
    history.replaceState(null, '', '/goals/O1');
    server = serve(fetchMock, { fail: 'network' });
    const { container } = render(
      <LocationProvider>
        <GoalDetailPage params={{ ref: 'O1' }} />
      </LocationProvider>,
    );
    expect(await screen.findByText('نسخة محفوظة · بلا اتصال')).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: /الصحة الجسدية/ })).toBeTruthy();
    const row = rowOf(container, 'm-late');
    expect((within(row).getByRole('button', { name: /^تعديل الموعد/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
