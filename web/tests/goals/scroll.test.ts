import { describe, expect, it } from 'vitest';

import { centeredScrollLeft } from '../../src/goals/scroll';

describe('centeredScrollLeft: where a scroller must be to centre one of its chips', () => {
  const base = { chipStart: 500, chipSize: 100, viewSize: 390, contentSize: 800 };

  it('left to right: the chip start minus the room beside it', () => {
    expect(centeredScrollLeft({ ...base, rtl: false })).toBe(355);
  });

  it('right to left: scrollLeft runs from 0 (the start, at the right) down to minus the overflow', () => {
    // the visible left edge must be 355; at scrollLeft 0 it is contentSize - viewSize = 410
    expect(centeredScrollLeft({ ...base, rtl: true })).toBe(-55);
  });

  it('never goes past either end', () => {
    expect(centeredScrollLeft({ ...base, chipStart: 0, rtl: false })).toBe(0);
    expect(centeredScrollLeft({ ...base, chipStart: 760, rtl: false })).toBe(410);
    expect(centeredScrollLeft({ ...base, chipStart: 0, rtl: true })).toBe(-410);
    expect(centeredScrollLeft({ ...base, chipStart: 760, rtl: true })).toBe(0);
  });

  it('a scroller that does not overflow stays at 0', () => {
    expect(centeredScrollLeft({ chipStart: 50, chipSize: 80, viewSize: 400, contentSize: 400, rtl: true })).toBe(0);
  });
});
