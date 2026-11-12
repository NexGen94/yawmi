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
  return !summary?.contains(el);
}

/** The elements Tab can reach inside `root`, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[inert], [hidden]') && !isHiddenInClosedDetails(el),
  );
}

// Open layers, in the order they opened. The topmost is the last one that contains no other.
const open: HTMLElement[] = [];
const inertByLayer = new Set<HTMLElement>();
let savedHtmlOverflow: string | null = null;
let savedBodyOverflow: string | null = null;

function topLayer(): HTMLElement | undefined {
  const innermost = open.filter((layer) => !open.some((other) => other !== layer && layer.contains(other)));
  return innermost.at(-1);
}

function isTop(root: HTMLElement): boolean {
  return topLayer() === root;
}

/** Locks root scrolling and marks every sibling branch outside the topmost open layer `inert`. */
function syncModalState(): void {
  const top = topLayer();
  if (!top) {
    for (const el of inertByLayer) {
      el.inert = false;
      el.removeAttribute('inert');
    }
    inertByLayer.clear();
    if (savedHtmlOverflow !== null) {
      document.documentElement.style.overflow = savedHtmlOverflow;
      savedHtmlOverflow = null;
    }
    if (savedBodyOverflow !== null) {
      document.body.style.overflow = savedBodyOverflow;
      savedBodyOverflow = null;
    }
    return;
  }

  if (savedHtmlOverflow === null) savedHtmlOverflow = document.documentElement.style.overflow;
  if (savedBodyOverflow === null) savedBodyOverflow = document.body.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  const nextInert = new Set<HTMLElement>();
  let branch: HTMLElement | null = top.parentElement?.classList.contains('layer') ? top.parentElement : top;
  while (branch && branch !== document.body && branch !== document.documentElement) {
    const parent: HTMLElement | null = branch.parentElement;
    if (!parent) break;
    for (const child of parent.children) {
      if (
        child instanceof HTMLElement &&
        child !== branch &&
        child.tagName !== 'SCRIPT' &&
        child.tagName !== 'STYLE'
      ) {
        nextInert.add(child);
      }
    }
    branch = parent;
  }

  for (const el of [...inertByLayer]) {
    if (!nextInert.has(el)) {
      el.inert = false;
      el.removeAttribute('inert');
      inertByLayer.delete(el);
    }
  }
  for (const el of nextInert) {
    if (!inertByLayer.has(el) && !el.inert && !el.hasAttribute('inert')) {
      el.inert = true;
      el.setAttribute('inert', '');
      inertByLayer.add(el);
    }
  }
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
    syncModalState();

    if (!root.contains(document.activeElement)) {
      const body = root.querySelector<HTMLElement>('[data-layer-body]');
      const all = focusables(root);
      const first =
        (body && focusables(body)[0]) ?? all.find((el) => el.dataset.layerClose === undefined) ?? all[0] ?? root;
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
      const last = items.at(-1);
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
    const backdrop = root.parentElement?.querySelector<HTMLElement>('[data-layer-backdrop]');
    const onBackdropClick = (): void => {
      if (isTop(root)) close.current();
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    backdrop?.addEventListener('click', onBackdropClick);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      backdrop?.removeEventListener('click', onBackdropClick);
      open.splice(open.indexOf(root), 1);
      syncModalState();
      if (opener?.isConnected) opener.focus();
    };
  }, [isOpen, panel]);
}
