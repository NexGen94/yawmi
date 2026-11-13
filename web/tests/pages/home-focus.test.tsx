// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomePage from '../../src/pages/home/index';
import { closeDb } from '../../src/sync/outbox';
import { PLAN_ID, plan, routeFocus, sessionOut } from '../helpers/focus-fixtures';
import { morningEntry, NOON_RIYADH } from '../helpers/today-fixtures';

vi.mock('../../src/sync/outbox', async (original) => ({
  ...(await original<typeof import('../../src/sync/outbox')>()),
  scheduleFlush: vi.fn(),
}));
vi.mock('../../src/push/subscribe', () => ({ setBadge: vi.fn(async () => undefined) }));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOON_RIYADH));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('home: the favourite focus combinations (quick access)', () => {
  it('lists each favourite plan as a link to the focus page with its plan', async () => {
    routeFocus(fetchMock, { plans: [plan({ favorite: true }), plan({ id: 'zz', title_ar: 'غير مفضلة', favorite: false })] });
    render(<HomePage />);
    const card = await screen.findByRole('region', { name: 'وصول سريع' });
    const link = await within(card).findByRole('link', { name: /عمل عميق/ });
    expect(link.getAttribute('href')).toBe(`/focus?plan=${PLAN_ID}`);
    expect(within(card).queryByText(/غير مفضلة/)).toBeNull();
    // The other shortcuts stay.
    expect(within(card).getByRole('link', { name: 'تسجيل عادة' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'سؤال' })).toBeTruthy();
  });

  it('with no favourite there is no empty heading or placeholder', async () => {
    routeFocus(fetchMock, { plans: [plan({ favorite: false })] });
    render(<HomePage />);
    const card = await screen.findByRole('region', { name: 'وصول سريع' });
    expect(within(card).queryByText(/التركيبات المفضلة/)).toBeNull();
  });

  it('a home page that cannot read the focus data still shows the habits', async () => {
    routeFocus(fetchMock, { plans: [plan({ favorite: true })] });
    const served = fetchMock.getMockImplementation() as (input: Request) => Promise<Response>;
    fetchMock.mockImplementation(async (input: Request) =>
      new URL(input.url).pathname.startsWith('/v1/focus') ? new Response('{}', { status: 500 }) : served(input),
    );
    render(<HomePage />);
    expect(await screen.findByText('3 من 6')).toBeTruthy();
    const card = screen.getByRole('region', { name: 'وصول سريع' });
    expect(within(card).queryByRole('link', { name: /عمل عميق/ })).toBeNull();
  });
});

describe('home: the focus score in the day summary', () => {
  const sessions = [
    sessionOut('2026-11-10T06:40:00Z', '2026-11-10T07:30:00Z', { actual_minutes: 45, id: '00000000-0000-7000-8000-0000000000b2' }),
    sessionOut('2026-11-09T06:40:00Z', '2026-11-09T07:30:00Z', { actual_minutes: 50, day: '2026-11-09' }),
  ];

  it('shows «50 · 45 من 90 دقيقة · للوعي الذاتي» with the minutes the morning planned', async () => {
    routeFocus(fetchMock, {
      sessions,
      journal: [morningEntry({ priorities: [], planned_minutes: 90 })],
    });
    render(<HomePage />);
    const summary = await screen.findByRole('region', { name: 'ملخص اليوم' });
    await waitFor(() => expect(summary.textContent).toContain('50 · 45 من 90 دقيقة · للوعي الذاتي'));
  });

  it('without a target it says so and shows no score', async () => {
    routeFocus(fetchMock, { sessions });
    render(<HomePage />);
    const summary = await screen.findByRole('region', { name: 'ملخص اليوم' });
    await waitFor(() => expect(summary.textContent).toContain('45 دقيقة'));
    expect(summary.textContent).toContain('لا هدف يومي للتركيز بعد');
    expect(summary.textContent).not.toContain('للوعي الذاتي');
  });

  it('shows nothing about focus when there are no minutes and no target', async () => {
    routeFocus(fetchMock, { sessions: [] });
    render(<HomePage />);
    const summary = await screen.findByRole('region', { name: 'ملخص اليوم' });
    expect(within(summary).queryByText(/التركيز/)).toBeNull();
  });
});
