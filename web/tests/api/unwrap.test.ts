import { describe, expect, it } from 'vitest';

import { HttpError, unwrap } from '../../src/api/unwrap';

const response = (status: number): Response => new Response(null, { status });

describe('unwrap', () => {
  it('returns the data of a successful result', () => {
    expect(unwrap({ data: { a: 1 }, response: response(200) })).toEqual({ a: 1 });
  });

  it('throws an HttpError that carries the status when the response is not ok', () => {
    try {
      unwrap({ response: response(500) });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(500);
    }
  });

  it('throws when a successful response has no data', () => {
    expect(() => unwrap({ response: response(204) })).toThrow(HttpError);
  });
});
