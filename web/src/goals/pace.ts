// `GET /v1/goals/{ref}/pace` for an outcome. A reference with no pace (a card, a milestone, an outcome
// the server does not know) is `null`. After an edit the pace is read again without going back to
// «loading», and the newest response wins.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { api } from '../api/client';
import { HttpError, unwrap } from '../api/unwrap';
import { useQuery } from '../data/query';
import { isOutcomeRef } from './target';
import type { PaceOut } from './types';

async function fetchPace(ref: string): Promise<PaceOut | null> {
  if (!isOutcomeRef(ref)) return null;
  try {
    return unwrap(await api.GET('/v1/goals/{ref}/pace', { params: { path: { ref } } }));
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

export interface UsePace {
  pace: PaceOut | null | undefined;
  /** Reads the pace again (the milestones changed), keeping the line on screen until it comes. */
  refresh(): Promise<void>;
}

export function usePace(ref: string): UsePace {
  const query = useQuery<PaceOut | null>(`goal-pace:${ref}`, () => fetchPace(ref));
  const [fresh, setFresh] = useState<PaceOut | null | undefined>(undefined);
  const asked = useRef(0);

  useEffect(() => {
    if (query.data !== undefined) setFresh(query.data);
  }, [query.data]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!isOutcomeRef(ref)) return;
    asked.current += 1;
    const mine = asked.current;
    try {
      const pace = await fetchPace(ref);
      if (mine === asked.current) setFresh(pace);
    } catch {
      // the line on screen stays
    }
  }, [ref]);

  return { pace: fresh !== undefined ? fresh : query.data, refresh };
}
