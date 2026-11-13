// `GET /v1/goals` for a page that edits what it shows. An edit answers with the row as it is now
// shown, and that row replaces the one on screen at once; a cancel answers only with the edit, so the
// plan is read again. Neither goes back to «loading»: the page, and the field being worked in, stay.
//
// The newest response always wins: a reading of the plan that was asked for before a later one never
// replaces it, and a reload of the first reading (a retry, coming back online) reaches the screen
// even after an edit has been laid over the plan.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import type { QueryResult } from '../data/query';
import { useGoals } from './data';
import type { CardFull, GoalsOut, MilestoneFull } from './types';

export interface EditableGoals extends QueryResult<GoalsOut> {
  replaceMilestone(row: MilestoneFull): void;
  replaceCard(row: CardFull): void;
  /** Reads the plan again, keeping what is on screen until it comes. */
  refetch(): Promise<void>;
}

export function useEditableGoals(): EditableGoals {
  const goals = useGoals();
  // What the screen shows once something newer than the first reading has come.
  const [shown, setShown] = useState<GoalsOut | undefined>(undefined);
  const loaded = useRef(goals.data);
  loaded.current = goals.data;
  const asked = useRef(0);

  // Every reading of the first query (a reload too) is newer than what an edit laid over the plan.
  useEffect(() => {
    if (goals.data !== undefined) setShown(goals.data);
  }, [goals.data]);

  const change = useCallback((apply: (plan: GoalsOut) => GoalsOut): void => {
    setShown((now) => {
      const plan = now ?? loaded.current;
      return plan === undefined ? now : apply(plan);
    });
  }, []);
  const replaceMilestone = useCallback(
    (row: MilestoneFull): void => change((plan) => ({ ...plan, milestones: plan.milestones.map((m) => (m.page_id === row.page_id ? row : m)) })),
    [change],
  );
  const replaceCard = useCallback(
    (row: CardFull): void => change((plan) => ({ ...plan, cards: plan.cards.map((c) => (c.page_id === row.page_id ? row : c)) })),
    [change],
  );
  const refetch = useCallback(async (): Promise<void> => {
    asked.current += 1;
    const mine = asked.current;
    try {
      const plan = unwrap(await api.GET('/v1/goals'));
      // only the reading asked for last is kept
      if (mine === asked.current) setShown(plan);
    } catch {
      // the plan on screen stays; the next load tells the truth
    }
  }, []);

  return { ...goals, data: shown ?? goals.data, replaceMilestone, replaceCard, refetch };
}
