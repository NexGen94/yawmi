import type { ComponentChildren } from 'preact';
import { useId, useRef } from 'preact/hooks';

import { CloseButton } from './CloseButton';
import { useModalLayer } from './layer';

export interface DialogProps {
  open: boolean;
  /** The heading, which also names the dialog. */
  title: string;
  /** Called by Escape, the close button and a click on the backdrop. */
  onClose(): void;
  children: ComponentChildren;
  /** Buttons under the content, the main one first. */
  actions?: ComponentChildren;
}

/** A modal dialog: focus moves to its first field or button, stays inside, Escape closes it, and
 *  focus goes back to what opened it. Rendered in place; it covers the window with position: fixed. */
export function Dialog({ open, title, onClose, children, actions }: DialogProps) {
  const panel = useRef<HTMLDialogElement>(null);
  const id = useId();
  useModalLayer(open, panel, onClose);
  if (!open) return null;
  return (
    <div class="layer">
      <div class="layer-backdrop" data-layer-backdrop aria-hidden="true" />
      <dialog ref={panel} open class="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <div class="layer-head">
          <h2 id={id} class="layer-title">
            {title}
          </h2>
          <CloseButton onClose={onClose} />
        </div>
        <div class="layer-body" data-layer-body>
          {children}
        </div>
        {actions && <div class="layer-actions">{actions}</div>}
      </dialog>
    </div>
  );
}
