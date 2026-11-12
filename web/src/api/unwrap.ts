// Turns an openapi-fetch result into its data or a thrown error that carries the HTTP status.
// `useQuery` reads that status: a refusal is an error state, a failed network is the offline state.

/** A response that is not a success: carries the HTTP status. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** The data of an openapi-fetch result, or a thrown `HttpError`. A failed network has already thrown a `TypeError`. */
export function unwrap<T>(result: { data?: T; response: Response }): T {
  if (!result.response.ok || result.data === undefined) throw new HttpError(result.response.status);
  return result.data;
}
