// The journal entries of the day and the saved evening review: what the morning and evening cards
// and the day summary read. A second query beside `useHabitsToday`, with its own saved copy.

import { useEffect, useMemo, useState } from 'preact/hooks';

import { api } from '../../api/client';
import type { components } from '../../api/schema';
import { applyPendingJournal } from '../../data/pending';
import { type QueryState, useQuery } from '../../data/query';
import type { Day } from '../../domain/types';
import { unwrap } from '../../habits/todayData';
import { listPending, type OutboxEvent } from '../../sync/outbox';

type JournalEntryOut = components['schemas']['JournalEntryOut'];
type InsightOut = components['schemas']['InsightOut'];

interface EntriesBundle {
  day: Day;
  journal: JournalEntryOut[];
  reviews: InsightOut[];
}

export const entriesQueryKey = (day: Day): string => `home-entries:${day}`;

async function loadEntries(day: Day): Promise<EntriesBundle> {
  const [journal, reviews] = await Promise.all([
    api.GET('/v1/journal', { params: { query: { from: day, to: day } } }).then(unwrap),
    api.GET('/v1/reviews', { params: { query: { kind: 'evening', limit: 1 } } }).then(unwrap),
  ]);
  return { day, journal: journal.entries, reviews: reviews.items };
}

export interface DayEntries {
  state: QueryState;
  stale: boolean;
  morning: JournalEntryOut | undefined;
  evening: JournalEntryOut | undefined;
  /** The evening review of today, once the day is closed and the server has written it. */
  review: InsightOut | undefined;
  /** The day is closed: an evening journal exists for today (saved, or still in the outbox). */
  closed: boolean;
  reload(): void;
}

export function useDayEntries(day: Day): DayEntries {
  const query = useQuery(entriesQueryKey(day), () => loadEntries(day));
  const [pending, setPending] = useState<OutboxEvent[]>([]);
  useEffect(() => {
    let alive = true;
    void listPending()
      .then((events) => alive && setPending(events))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [day]);

  const bundle = query.data?.day === day ? query.data : undefined;
  const state: QueryState = query.state === 'loading' && bundle !== undefined ? 'ready' : query.state;

  return useMemo(() => {
    const entries = bundle === undefined ? [] : applyPendingJournal(bundle.journal, pending);
    const ofDay = (part: 'morning' | 'evening') => entries.find((e) => e.day === day && e.part === part);
    const review = bundle?.reviews.find((r) => r.day === day);
    const evening = ofDay('evening');
    return {
      state,
      stale: query.stale,
      morning: ofDay('morning'),
      evening,
      review,
      closed: evening !== undefined || review !== undefined,
      reload: query.reload,
    };
  }, [bundle, pending, day, state, query.stale, query.reload]);
}
