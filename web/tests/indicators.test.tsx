// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IndicatorCard } from '../src/indicators/IndicatorCard';
import IndicatorDialog from '../src/indicators/IndicatorDialog';
import { IndicatorPanel } from '../src/indicators/IndicatorPanel';
import { stored } from '../src/indicators/types';
import { setDigits } from '../src/lib/format';
import GoalDetailPage from '../src/pages/goals/detail';
import HabitDetailPage from '../src/pages/habits/detail';
import type { IndicatorView } from '../src/progress/indicator';
import { clearOutbox, closeDb } from '../src/sync/outbox';
import { detailGoals, serve as serveGoals } from './helpers/goal-detail-fixtures';
import { indicator, withIndicators } from './helpers/indicator-fixtures';
import { habit, type HabitOut, type ProgressOut, routeFetch, todayOut, NOON_RIYADH } from './helpers/today-fixtures';

vi.mock('../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));

let fetchMock: ReturnType<typeof vi.fn>;

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

const SUBJECT = { kind: 'habit', ref: 'english', title: 'الإنجليزية' } as const;
const VIEW: IndicatorView = { value: 0.3, target: null, completion: 0.3, text: '30%' };

describe('IndicatorCard', () => {
  it('draws a ring with its number and opens the dialog from its button', () => {
    const onCustomize = vi.fn();
    render(<IndicatorCard subject={SUBJECT} value={VIEW} display="ring" onCustomize={onCustomize} />);
    expect(screen.getByRole('img', { name: /30/ })).toBeTruthy();
    expect(screen.getByText('30%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'تخصيص وإضافة تذكير' }));
    expect(onCustomize).toHaveBeenCalledTimes(1);
  });

  it('a value that is not there is a dash with its reason, never 0% or NaN', () => {
    const empty: IndicatorView = { value: null, target: null, completion: null, text: '—', reason: 'لا مهام بعد' };
    const { container } = render(<IndicatorCard subject={SUBJECT} value={empty} display="ring" onCustomize={() => undefined} />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('لا مهام بعد')).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|0%|٠/);
  });

  it('shows a bar, a number or a sparkline as asked', () => {
    const series: IndicatorView = { ...VIEW, series: [1, 3, 2, 5] };
    const bar = render(<IndicatorCard subject={SUBJECT} value={VIEW} display="bar" onCustomize={() => undefined} />);
    expect(bar.container.querySelector('.bar')).toBeTruthy();
    bar.unmount();
    const number = render(<IndicatorCard subject={SUBJECT} value={VIEW} display="number" onCustomize={() => undefined} />);
    expect(number.container.querySelector('.ring, .bar, .spark')).toBeNull();
    number.unmount();
    const spark = render(<IndicatorCard subject={SUBJECT} value={series} display="sparkline" onCustomize={() => undefined} />);
    expect(spark.container.querySelector('.spark')).toBeTruthy();
  });
});

const ENGLISH = habit('english', 'الإنجليزية', {
  kind: 'duration',
  unit: 'min',
  period: 'week',
  target_per_period: 285,
  start_day: '2026-11-01',
  reminders: [{ time: '21:30', days_mask: 127 }],
});

const props_habit = (over: { habit?: HabitOut }): HabitOut => over.habit ?? ENGLISH;

/** The dialog for a habit or a goal, over a recording server. */
function openDialog(over: Partial<Parameters<typeof IndicatorDialog>[0]> = {}, indicators = [indicator()]) {
  fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
  const server = withIndicators(fetchMock, { indicators, habits: [props_habit(over)] });
  const onChanged = vi.fn();
  const onClose = vi.fn();
  const props = {
    open: true,
    onClose,
    onChanged,
    subject: SUBJECT,
    habit: ENGLISH,
    config: stored(indicator()),
    online: true,
    ...over,
  } as Parameters<typeof IndicatorDialog>[0];
  render(<IndicatorDialog {...props} />);
  return { server, onChanged, onClose };
}

const GOAL_SUBJECT = { kind: 'goal', ref: 'O1', title: 'الصحة الجسدية' } as const;
const GOAL_VALUE = { source: 'milestones', value: 1, target: 3, completion: 1 / 3, display: 'ring', custom: false } as const;

describe('IndicatorDialog', () => {
  it('a habit offers the five measures', () => {
    openDialog();
    const group = screen.getByRole('radiogroup', { name: 'القياس' });
    const names = within(group).getAllByRole('radio').map((r) => r.textContent);
    expect(names).toEqual(['نسبة الإنجاز', 'المجموع', 'متوسط 7 أيام', 'متوسط 30 يوماً', 'درجة القوة']);
  });

  it('a goal offers the three sources', () => {
    openDialog({ subject: GOAL_SUBJECT, habit: undefined, goal: GOAL_VALUE, config: undefined });
    const group = screen.getByRole('radiogroup', { name: 'المصدر' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['المحطات', 'العادات المرتبطة', 'المهام']);
    expect(screen.queryByRole('radiogroup', { name: 'القياس' })).toBeNull();
  });

  it('«حفظ» puts the indicator once, with what was chosen', async () => {
    const { server, onChanged } = openDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'متوسط 7 أيام' }));
    fireEvent.click(screen.getByRole('radio', { name: 'شريط' }));
    fireEvent.input(screen.getByLabelText('المستهدف'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const puts = server.called('PUT', '/v1/indicators/habit/english');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toMatchObject({
      subject_kind: 'habit',
      subject_ref: 'english',
      source: 'habit_logs',
      measure: 'avg_7d',
      target: 300,
      display: 'bar',
    });
    expect(server.called('DELETE', /./)).toHaveLength(0);
  });

  it('a target that is not a positive number is refused before any request', () => {
    const { server } = openDialog();
    fireEvent.input(screen.getByLabelText('المستهدف'), { target: { value: '-4' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(screen.getByText('المستهدف عدد موجب.')).toBeTruthy();
    expect(server.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('«إعادة إلى الافتراض» deletes the indicator once', async () => {
    const { server, onChanged } = openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة إلى الافتراض' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(server.called('DELETE', '/v1/indicators/habit/english')).toHaveLength(1);
    expect(server.called('PUT', /./)).toHaveLength(0);
  });

  it('a refused save says so and keeps the dialog open', async () => {
    const { onChanged, onClose } = openDialog();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect((await screen.findByRole('alert')).textContent).toContain('تعذّر الحفظ');
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('without a connection the writes are disabled and say why', () => {
    openDialog({ online: false });
    expect((screen.getByRole('button', { name: 'حفظ' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'إعادة إلى الافتراض' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'إضافة تذكير' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('يحتاج اتصالاً').length).toBeGreaterThanOrEqual(1);
  });

  describe('«إضافة تذكير»', () => {
    const setTime = (value: string): void => {
      fireEvent.input(screen.getByLabelText('وقت التذكير الجديد'), { target: { value } });
    };

    it('a habit with one reminder: adding one at 20:00 patches the habit once with two, and puts no indicator', async () => {
      const { server, onChanged } = openDialog();
      setTime('20:00');
      fireEvent.click(screen.getByRole('button', { name: 'إضافة تذكير' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      const patches = server.called('PATCH', '/v1/habits/english');
      expect(patches).toHaveLength(1);
      expect(patches[0]?.body).toEqual({
        reminders: [
          { time: '21:30', days_mask: 127 },
          { time: '20:00', days_mask: 127 },
        ],
      });
      expect(server.called('PUT', /./)).toHaveLength(0);
    });

    it('M-4: two reminders added one after the other both stay, before the page has read the habit again', async () => {
      const { server, onChanged } = openDialog();
      setTime('20:00');
      fireEvent.click(screen.getByRole('button', { name: 'إضافة تذكير' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      // the page has not reloaded the habit: the dialog still holds the one it was given
      await waitFor(() => expect((screen.getByRole('button', { name: 'إضافة تذكير' }) as HTMLButtonElement).disabled).toBe(false));
      setTime('21:00');
      fireEvent.click(screen.getByRole('button', { name: 'إضافة تذكير' }));
      await waitFor(() => expect(server.called('PATCH', '/v1/habits/english')).toHaveLength(2));
      expect(server.called('PATCH', '/v1/habits/english')[1]?.body).toEqual({
        reminders: [
          { time: '21:30', days_mask: 127 },
          { time: '20:00', days_mask: 127 },
          { time: '21:00', days_mask: 127 },
        ],
      });
    });

    it('changing a reminder that exists patches the habit with that one changed', async () => {
      const { server } = openDialog();
      fireEvent.input(screen.getByLabelText('وقت التذكير 1'), { target: { value: '22:00' } });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ التذكير 1' }));
      await waitFor(() => expect(server.called('PATCH', '/v1/habits/english')).toHaveLength(1));
      expect(server.called('PATCH', '/v1/habits/english')[0]?.body).toEqual({ reminders: [{ time: '22:00', days_mask: 127 }] });
    });

    it('a habit with three reminders cannot take a fourth, and says why', () => {
      const full = habit('english', 'الإنجليزية', {
        kind: 'duration',
        unit: 'min',
        period: 'week',
        target_per_period: 285,
        reminders: [
          { time: '07:00', days_mask: 127 },
          { time: '13:00', days_mask: 127 },
          { time: '21:00', days_mask: 127 },
        ],
      });
      openDialog({ habit: full });
      expect((screen.getByRole('button', { name: 'إضافة تذكير' }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText('ثلاثة تذكيرات على الأكثر')).toBeTruthy();
    });

    it('a system habit may take a reminder', async () => {
      const system = habit('english', 'الإنجليزية', { system: true, created_by: 'seed', reminders: [] });
      const { server } = openDialog({ habit: system });
      setTime('20:00');
      fireEvent.click(screen.getByRole('button', { name: 'إضافة تذكير' }));
      await waitFor(() => expect(server.called('PATCH', '/v1/habits/english')).toHaveLength(1));
      expect(server.called('PATCH', '/v1/habits/english')[0]?.body).toEqual({ reminders: [{ time: '20:00', days_mask: 127 }] });
    });

    it('a goal: adding one at 20:00 puts the indicator once with that reminder', async () => {
      const { server, onChanged } = openDialog({ subject: GOAL_SUBJECT, habit: undefined, goal: GOAL_VALUE, config: undefined }, []);
      setTime('20:00');
      fireEvent.click(screen.getByRole('button', { name: 'إضافة تذكير' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      const puts = server.called('PUT', '/v1/indicators/goal/O1');
      expect(puts).toHaveLength(1);
      expect(puts[0]?.body).toMatchObject({
        subject_kind: 'goal',
        subject_ref: 'O1',
        source: 'milestones',
        measure: 'completion',
        reminder: { time: '20:00', days_mask: 127 },
      });
      expect(server.called('PATCH', /./)).toHaveLength(0);
    });

    it('a time that is empty is refused before any request', () => {
      const { server } = openDialog();
      setTime('');
      fireEvent.click(screen.getByRole('button', { name: 'إضافة تذكير' }));
      expect(screen.getByText('الوقت مطلوب.')).toBeTruthy();
      expect(server.calls).toHaveLength(0);
    });
  });
});

describe('the card on the pages', () => {
  const PROGRESS: ProgressOut = {
    adherence: 0.8,
    challenge: null,
    last_8_periods: [0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.5],
    period_progress: { completion: 0.55, done: 25, expected: 45, need_per_day: 20, on_track: false, reached: false, target: 45 },
    streak: 3,
    strength: 0.756582,
    total_done: 85,
  };

  it('is on the detail page of a habit, with the completion of its week', async () => {
    const habits: HabitOut[] = [ENGLISH];
    routeFetch(fetchMock, {
      habits,
      today: todayOut(habits),
      logs: [
        { habit_code: 'english', day: '2026-11-08', status: 'done', value: 60 },
        { habit_code: 'english', day: '2026-11-10', status: 'done', value: 25 },
      ],
      progress: { english: PROGRESS },
    });
    withIndicators(fetchMock, { habits });
    history.replaceState(null, '', '/habits/english');
    render(
      <LocationProvider>
        <HabitDetailPage params={{ code: 'english' }} />
      </LocationProvider>,
    );
    const card = await screen.findByRole('region', { name: 'المؤشر' });
    // 85 of 285: S3 of the design
    expect(within(card).getByText('30%')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'تخصيص وإضافة تذكير' })).toBeTruthy();
  });

  it('is on the detail page of a goal, as the server computed it, and opens the lazy dialog', async () => {
    serveGoals(fetchMock, { goals: detailGoals() });
    withIndicators(fetchMock);
    history.replaceState(null, '', '/goals/O1');
    render(
      <LocationProvider>
        <GoalDetailPage params={{ ref: 'O1' }} />
      </LocationProvider>,
    );
    const card = await screen.findByRole('region', { name: 'المؤشر' });
    // the fixture's outcome has no computed value: a dash and why
    expect(within(card).getByText('—')).toBeTruthy();
    expect(within(card).getByText('لا محطات بعد')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'تخصيص وإضافة تذكير' }));
    expect(await screen.findByRole('dialog', { name: 'تخصيص المؤشر' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'المصدر' })).toBeTruthy();
  });

  it('the panel shows the card and opens the dialog only when asked', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
    render(
      <IndicatorPanel
        subject={SUBJECT}
        view={VIEW}
        display="ring"
        online
        habit={ENGLISH}
        config={undefined}
        onChanged={() => undefined}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'تخصيص وإضافة تذكير' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
