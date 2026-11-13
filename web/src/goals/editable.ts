// `GET /v1/goals` for a page that edits what it shows. An edit answers with the row as it is now
// shown, and that row replaces the one on screen at once; a cancel answers only with the edit, so the
// plan is read again. Neither goes back to «loading»: the page, and the field being worked in, stay.

import { useCallback, useRef, useState } from 'preact/hooks';

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
  const [fresh, setFresh] = useState<GoalsOut | undefined>(undefined);
  const loaded = useRef(goals.data);
  loaded.current = goals.data;

  const change = useCallback((apply: (plan: GoalsOut) => GoalsOut): void => {
    setFresh((now) => {
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
    try {
      setFresh(unwrap(await api.GET('/v1/goals')));
    } catch {
      // the plan on screen stays; the next load tells the truth
    }
  }, []);

  return { ...goals, data: fresh ?? goals.data, replaceMilestone, replaceCard, refetch };
}
