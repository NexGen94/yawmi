// The indicator models, as the server's generated contract names them (design 7.5). The server sets
// `id` and `updated_at` on everything it sends, but the schema leaves them optional (they are
// read-only fields of the one model that is also the body of a PUT): `stored` narrows them once,
// here, and nothing else reads them as possibly missing.

import type { components } from '../api/schema';

export type IndicatorIO = components['schemas']['IndicatorIO'];
export type IndicatorMeasure = IndicatorIO['measure'];
export type IndicatorPeriod = IndicatorIO['period'];
export type IndicatorDisplay = IndicatorIO['display'];
export type IndicatorSource = IndicatorIO['source'];
export type IndicatorKind = IndicatorIO['subject_kind'];

/** An indicator as the server sends it back: with its identity and the time it was saved. */
export type StoredIndicator = IndicatorIO & { id: string; updated_at: string };

/** The server's reply narrowed: the two fields it always sets are no longer optional. */
export function stored(item: IndicatorIO): StoredIndicator {
  return { ...item, id: item.id ?? '', updated_at: item.updated_at ?? '' };
}

/** One indicator per subject (design 13.1, ruling 3): the pair is its key. */
export function indicatorKey(kind: IndicatorKind, ref: string): string {
  return `${kind}:${ref}`;
}
