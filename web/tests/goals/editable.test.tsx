// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, renderHook, waitFor } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditableGoals } from '../../src/goals/editable';
import { closeDb } from '../../src/sync/outbox';
import { type GoalsOut, goals } from '../helpers/goals-fixtures';

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const named = (title: string): GoalsOut => ({ ...goals(), cards: [{ ...goals().cards[0]!, title }] });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
});

const titleOf = (data: GoalsOut | undefined): string | undefined => data?.cards[0]?.title;

describe('useEditableGoals: the newest response always wins (M-5)', () => {
  it('a reload after an edit reaches the screen, not the copy the edit made', async () => {
    fetchMock.mockImplementation(async () => json(named('الأولى')));
    const { result } = renderHook(() => useEditableGoals());
    await waitFor(() => expect(titleOf(result.current.data)).toBe('الأولى'));
    act(() => result.current.replaceMilestone({ ...result.current.data!.milestones[0]!, title: 'معدّلة' }));
    expect(result.current.data?.milestones[0]?.title).toBe('معدّلة');
    fetchMock.mockImplementation(async () => json(named('الثانية')));
    act(() => result.current.reload());
    await waitFor(() => expect(titleOf(result.current.data)).toBe('الثانية'));
  });

  it('of two readings of the plan, the one asked for last stays, even when the first answers last', async () => {
    fetchMock.mockImplementation(async () => json(named('الأولى')));
    const { result } = renderHook(() => useEditableGoals());
    await waitFor(() => expect(titleOf(result.current.data)).toBe('الأولى'));

    let release: () => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(named('قديمة')));
        }),
    );
    fetchMock.mockImplementationOnce(async () => json(named('أحدث')));
    let slow: Promise<void> = Promise.resolve();
    act(() => {
      slow = result.current.refetch();
    });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(titleOf(result.current.data)).toBe('أحدث'));
    await act(async () => {
      release();
      await slow;
    });
    expect(titleOf(result.current.data)).toBe('أحدث');
  });
});
