// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomePage from '../../src/pages/home/index';
import { closeDb } from '../../src/sync/outbox';
import { card, insightOut } from '../helpers/ai-fixtures';
import { eveningEntry, morningInsight, NOON_RIYADH, routeFetch, STORY_HABITS, todayOut } from '../helpers/today-fixtures';

// The summary card of the day follows `ai_checkin` (design 4.1): `morning` before the closing,
// `evening` after it. A stored row older than task 18 (no cards) shows its words all the same.

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

const MORNING = 'الصباح: المشي أولاً.';
const EVENING = 'المساء: يوم مستقر.';
const stored = morningInsight({ lines: [MORNING], source_ids: ['habit:walk'], cards: [card('habit:walk')] });
const review = insightOut({ lines: [EVENING], day: '2026-11-10' });

async function home(checkin: 'morning' | 'evening', closed: boolean): Promise<void> {
  routeFetch(fetchMock, {
    settings: { ai_checkin: checkin },
    today: todayOut(STORY_HABITS, { insight: stored }),
    journal: closed ? [eveningEntry()] : [],
    reviews: closed ? [review] : [],
  });
  render(<HomePage />);
  await screen.findByText('3 من 6');
  await waitFor(() => expect(fetchMock.mock.calls.some(([r]) => new URL((r as Request).url).pathname === '/v1/settings')).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('home: the day summary by ai_checkin', () => {
  it('morning, before the closing: the morning lines show', async () => {
    await home('morning', false);
    expect(await screen.findByText(MORNING)).toBeTruthy();
  });

  it('morning, after the closing: no summary of the AI', async () => {
    await home('morning', true);
    expect(screen.queryByText(MORNING)).toBeNull();
    expect(screen.queryByText(EVENING)).toBeNull();
  });

  it('evening, before the closing: no summary of the AI', async () => {
    await home('evening', false);
    expect(screen.queryByText(MORNING)).toBeNull();
  });

  it('evening, after the closing: the evening lines show', async () => {
    await home('evening', true);
    expect(await screen.findByText(EVENING)).toBeTruthy();
  });

  it('a stored row without cards shows its words, not an error', async () => {
    routeFetch(fetchMock, {
      settings: { ai_checkin: 'morning' },
      today: todayOut(STORY_HABITS, { insight: morningInsight({ lines: ['نص قديم.'], source_ids: ['goal:O1'], cards: [] }) }),
    });
    render(<HomePage />);
    expect(await screen.findByText('نص قديم.')).toBeTruthy();
    expect(screen.queryByText('تعذّر التحليل اليوم')).toBeNull();
  });
});
