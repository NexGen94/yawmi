/**
 * Whether `error` is what an aborted `fetch` rejects with: the `TimeoutError` of
 * `AbortSignal.timeout`, or an `AbortError`. Both are `DOMException`s, not `TypeError`s, so code
 * that treats `TypeError` as "offline" has to ask for them separately.
 */
export function isAbortOrTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof error === 'object' && error !== null && (name === 'TimeoutError' || name === 'AbortError');
}
