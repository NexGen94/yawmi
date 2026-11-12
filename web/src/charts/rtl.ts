// The one place where charts become right-to-left. SVG coordinates are physical (x grows to the
// right), and the app reads from the right, so every horizontal position a chart draws goes
// through these two functions: index 0, the start of the series, sits at the right edge.
// Numbers and clock times are text, not geometry, so they never flip.

/** Mirrors a horizontal position inside `width`: 0 becomes the right edge. */
export function flip(px: number, width: number): number {
  return width - px;
}

/** The centre of slot `i` of `n` equal slots across `width`, slot 0 at the inline start (the right
 *  edge in RTL): x(0, 8, 320) = 300, x(7, 8, 320) = 20. */
export function x(i: number, n: number, width: number): number {
  return flip(((i + 0.5) * width) / n, width);
}
