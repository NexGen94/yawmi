import { describe, expect, it } from 'vitest';

import { uuidv7 } from '../src/sync/uuidv7';

const fixedRand = (bytes: number[]) => (n: number) => {
  expect(n).toBe(10);
  return Uint8Array.from(bytes);
};

describe('uuidv7', () => {
  it('matches the RFC 9562 appendix A.6 example', () => {
    // unix_ts_ms 0x017F22E279B0, rand_a 0xCC3, rand_b 0x18C4DC0C0C07398F
    const id = uuidv7(
      0x017f22e279b0,
      fixedRand([0x0c, 0xc3, 0x18, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f]),
    );
    expect(id).toBe('017f22e2-79b0-7cc3-98c4-dc0c0c07398f');
  });

  it('has version 7 at index 14 and variant 10 at index 19, whatever the random bytes', () => {
    for (const fill of [0x00, 0xff, 0xa5]) {
      const id = uuidv7(Date.now(), fixedRand(Array<number>(10).fill(fill)));
      expect(id[14]).toBe('7');
      expect(id[19]).toMatch(/[89ab]/);
    }
    for (let i = 0; i < 200; i += 1) {
      const id = uuidv7();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('encodes the 48-bit millisecond timestamp in the first 12 hex digits', () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 0, 123);
    const id = uuidv7(now);
    expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(now);
  });

  it('sorts lexicographically by timestamp', () => {
    const base = Date.UTC(2026, 10, 10);
    const ids = [base + 5_000, base, base + 1, base + 2 ** 32, base + 60_000].map((t) => uuidv7(t));
    const sorted = [...ids].sort();
    expect(sorted).toEqual([ids[1], ids[2], ids[0], ids[4], ids[3]]);
  });

  it('does not repeat when called twice in the same millisecond', () => {
    const now = Date.now();
    expect(uuidv7(now)).not.toBe(uuidv7(now));
  });

  it('rejects a timestamp outside 48 bits', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
  });
});
