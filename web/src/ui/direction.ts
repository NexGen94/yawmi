// Arrow keys follow what the eye sees: in a right-to-left row, ArrowLeft moves forward. The app is
// RTL (index.html sets dir="rtl"), so an element with no dir above it counts as RTL too.

export function isRtl(el: Element): boolean {
  const dir = el.closest('[dir]')?.getAttribute('dir')?.toLowerCase();
  return dir === undefined || dir === 'rtl' || dir === 'auto';
}

/** +1 for a key that moves forward along a horizontal row in reading order, -1 for back, 0 else.
 *  Up and Down count as back and forward. */
export function rowStep(key: string, el: Element): -1 | 0 | 1 {
  const rtl = isRtl(el);
  switch (key) {
    case 'ArrowLeft':
      return rtl ? 1 : -1;
    case 'ArrowRight':
      return rtl ? -1 : 1;
    case 'ArrowDown':
      return 1;
    case 'ArrowUp':
      return -1;
    default:
      return 0;
  }
}
