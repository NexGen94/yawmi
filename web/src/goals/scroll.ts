// Where a horizontal scroller must be to put one of its children in the middle. Only the scroller
// moves: `scrollIntoView` would move the whole window too, which on a phone throws the page down to
// the switch.

export interface CenterInput {
  /** Distance from the left edge of the scrolled content to the child (`offsetLeft`). */
  chipStart: number;
  chipSize: number;
  /** The visible width of the scroller (`clientWidth`) and the width of what it holds (`scrollWidth`). */
  viewSize: number;
  contentSize: number;
  /** The scroller reads right to left: its `scrollLeft` is 0 at the right and goes negative. */
  rtl: boolean;
}

/** The `scrollLeft` that centres the child, held inside what the scroller can reach. */
export function centeredScrollLeft({ chipStart, chipSize, viewSize, contentSize, rtl }: CenterInput): number {
  const overflow = Math.max(0, contentSize - viewSize);
  // The content edge that must sit at the left of the view, counted from the left of the content.
  const visibleLeft = chipStart - (viewSize - chipSize) / 2;
  const target = rtl ? visibleLeft - overflow : visibleLeft;
  const held = rtl ? Math.min(0, Math.max(-overflow, target)) : Math.min(overflow, Math.max(0, target));
  return held || 0; // never -0
}

/** Brings `chip` to the middle of `scroller`, moving the scroller alone. */
export function centerInScroller(scroller: HTMLElement, chip: HTMLElement): void {
  scroller.scrollLeft = centeredScrollLeft({
    chipStart: chip.offsetLeft,
    chipSize: chip.offsetWidth,
    viewSize: scroller.clientWidth,
    contentSize: scroller.scrollWidth,
    rtl: getComputedStyle(scroller).direction === 'rtl',
  });
}
