// The typed API client: openapi-fetch over the generated `paths` (schema.d.ts, from
// openapi/openapi.json with `npm run gen:api`), sending through `authedFetch`, so every call
// carries the in-memory bearer token, shares one cookie refresh on a 401 and is replayed once.
// A dead session surfaces as a thrown `Unauthorized`, as with `authedFetch` itself.

import createClient, { type ClientOptions } from 'openapi-fetch';

import { authedFetch } from './auth';
import type { paths } from './schema';

/**
 * Empty, not `/v1`: every path in the generated schema already starts with `/v1/`
 * (`/v1/events`, `/v1/habits`, ...) and openapi-fetch joins `baseUrl + path`, so a `/v1` base
 * would request `/v1/v1/events`. Relative, so the browser resolves it against the page origin.
 */
export const API_BASE_URL = '';

export function createApi(options: Omit<ClientOptions, 'fetch'> = {}) {
  return createClient<paths>({ baseUrl: API_BASE_URL, ...options, fetch: authedFetch });
}

export const api = createApi();
