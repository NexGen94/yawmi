// What the indicator screens read and write. The indicators of both kinds come in one list
// (`GET /v1/indicators`); a page takes the one for its subject. Writing is a settings call: it needs
// the network and is never queued (design 13.1, ruling 22), so these functions answer true or false
// and never throw.

import { useMemo } from 'preact/hooks';

import { api } from '../api/client';
import { unwrap } from '../api/unwrap';
import { type QueryResult, useQuery } from '../data/query';
import { isAbortOrTimeout } from '../lib/timeout';
import { type IndicatorIO, type IndicatorKind, indicatorKey, type StoredIndicator, stored } from './types';

export const indicatorsQueryKey = 'indicators';

/** How long the server has to answer a write. */
export const WRITE_TIMEOUT_MS = 15_000;

export interface Indicators {
  /** The stored indicator of a subject, or `undefined` (the default then applies). */
  get(kind: IndicatorKind, ref: string): StoredIndicator | undefined;
  query: QueryResult<StoredIndicator[]>;
}

export function useIndicators(): Indicators {
  const query = useQuery(indicatorsQueryKey, async () => (await api.GET('/v1/indicators').then(unwrap)).items.map(stored));
  const byKey = useMemo(() => new Map((query.data ?? []).map((item) => [indicatorKey(item.subject_kind, item.subject_ref), item])), [query.data]);
  return { get: (kind, ref) => byKey.get(indicatorKey(kind, ref)), query };
}

/** `PUT /v1/indicators/{kind}/{ref}`: creates the indicator or replaces it. */
export async function putIndicator(body: IndicatorIO): Promise<boolean> {
  try {
    const result = await api.PUT('/v1/indicators/{subject_kind}/{subject_ref}', {
      params: { path: { subject_kind: body.subject_kind, subject_ref: body.subject_ref } },
      body,
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    return result.response.ok;
  } catch (error: unknown) {
    if (error instanceof TypeError || isAbortOrTimeout(error)) return false;
    throw error;
  }
}

/** `DELETE /v1/indicators/{kind}/{ref}`: the subject goes back to its default. */
export async function deleteIndicator(kind: IndicatorKind, ref: string): Promise<boolean> {
  try {
    const result = await api.DELETE('/v1/indicators/{subject_kind}/{subject_ref}', {
      params: { path: { subject_kind: kind, subject_ref: ref } },
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    return result.response.ok;
  } catch (error: unknown) {
    if (error instanceof TypeError || isAbortOrTimeout(error)) return false;
    throw error;
  }
}
