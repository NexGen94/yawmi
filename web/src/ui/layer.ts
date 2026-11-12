// Shared behaviour of the modal layers (Dialog, Drawer): focus moves in when one opens, Tab and
// Shift+Tab stay inside, focus that escapes is pulled back, Escape closes, and focus returns to
// whatever opened it. Only the topmost open layer answers, so Escape in a dialog inside a drawer
// closes the dialog alone.

import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

const FOCUSABLE = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'summary:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isHiddenInClosedDetails(el: HTMLElement): boolean {
  const details = el.closest('details');
  if (!details || details.open) return false;
  const summary = details.querySelector(':scope > summary');
  return !summary || !summary.contains(el);
}

/** The elements Tab can reach inside `root`, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[inert], [hidden]') && !isHiddenInClosedDetails(el),
  );
}

// Open layers, in the order they opened. The topmost is the last one that contains no other.
const open: HTMLElement[] = [];

function isTop(root: HTMLElement): boolean {
  const innermost = open.filter((layer) => !open.some((other) => other !== layer && layer.contains(other)));
  return innermost[innermost.length - 1] === root;
}

/** Makes `panel` a modal layer while `isOpen`. The first focusable element inside the part marked
 *  `data-layer-body` takes the focus, else the first one that is not the close button (marked
 *  `data-layer-close`), else the close button, else the panel itself. */
export function useModalLayer(isOpen: boolean, panel: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;

  // A layout effect, not useEffect: Preact 11 runs effect cleanups after the next paint, which
  // would leave the focus on <body> for a frame after closing. This runs in the commit itself.
  useLayoutEffect(() => {
    const root = panel.current;
    if (!isOpen || !root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    open.push(root);

    if (!root.contains(document.activeElement)) {
      const body = root.querySelector<HTMLElement>('[data-layer-body]');
      const all = focusables(root);
      const first =
        (body && focusables(body)[0]) ?? all.find((el) => !el.hasAttribute('data-layer-close')) ?? all[0] ?? root;
      first.focus();
    }

    const onKey = (event: KeyboardEvent): void => {
      if (!isTop(root)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement;
      const outside = !root.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (!isTop(root) || !(event.target instanceof Node) || root.contains(event.target)) return;
      (focusables(root)[0] ?? root).focus();
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      open.splice(open.indexOf(root), 1);
      if (opener?.isConnected) opener.focus();
    };
  }, [isOpen, panel]);
}
