import type { ComponentChildren } from 'preact';
import { useId, useRef } from 'preact/hooks';

import { CloseButton } from './CloseButton';
import { useModalLayer } from './layer';

export interface DrawerProps {
  open: boolean;
  /** The heading, which also names the panel. */
  title: string;
  /** Called by Escape, the close button and a click on the backdrop. */
  onClose(): void;
  children: ComponentChildren;
}

/** A side panel at the inline end (the left in RTL), full height, modal like Dialog: it traps the
 *  focus, closes with Escape, and gives the focus back. */
export function Drawer({ open, title, onClose, children }: DrawerProps) {
  const panel = useRef<HTMLDialogElement>(null);
  const id = useId();
  useModalLayer(open, panel, onClose);
  if (!open) return null;
  return (
    <div class="layer layer-drawer">
      <div class="layer-backdrop" data-layer-backdrop aria-hidden="true" />
      <dialog ref={panel} open class="drawer" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <div class="layer-head">
          <h2 id={id} class="layer-title">
            {title}
          </h2>
          <CloseButton onClose={onClose} />
        </div>
        <div class="layer-body" data-layer-body>
          {children}
        </div>
      </dialog>
    </div>
  );
}
