import type { ComponentType } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { onAskOpen } from '../ask/controller';
import type { AskPanelProps } from '../pages/ask/AskPanel';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { Skeleton } from '../ui/Skeleton';

/** The field of the question inside the page `/ask`, if that page is the one on screen. */
function askPageField(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#main .ask-page .field-input');
}

/** The side panel of «اسأل» (design 3): it opens from the header button and from Ctrl+K and /, on
 *  every page. The panel itself is a lazy chunk, loaded the first time it opens, so it stays out of
 *  the first load. On the /ask page the shortcut only moves the focus to the field that is there. */
export function AskDrawer() {
  const [open, setOpen] = useState(false);
  const [Panel, setPanel] = useState<ComponentType<AskPanelProps> | null>(null);
  const submit = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(
    () =>
      onAskOpen(() => {
        const field = askPageField();
        if (field) {
          field.focus();
          return;
        }
        setOpen(true);
      }),
    [],
  );

  useEffect(() => {
    if (!open || Panel !== null) return;
    let alive = true;
    setFailed(false);
    import('../pages/ask/AskPanel').then(
      (module) => alive && setPanel(() => module.AskPanel),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [open, Panel, nonce]);

  // The panel arrives after the drawer opened (the first time): the focus goes to its field then.
  useEffect(() => {
    if (!open || Panel === null) return;
    const field = document.querySelector<HTMLElement>('.drawer .field-input');
    // Unless the person already moved into the panel's own content.
    const inBody = document.activeElement?.closest('.drawer [data-layer-body]') ?? null;
    if (field && inBody === null) field.focus();
  }, [open, Panel]);

  return (
    <Drawer
      open={open}
      title="اسأل"
      onClose={() => setOpen(false)}
      actions={
        Panel !== null ? (
          <Button variant="primary" disabled={busy} onClick={() => submit.current?.()}>
            سؤال
          </Button>
        ) : undefined
      }
    >
      {Panel !== null ? (
        <Panel pinned={{ submitRef: submit, onBusy: setBusy }} />
      ) : failed ? (
        <div class="state-message" role="alert">
          <p class="state-text">تعذّر التحميل</p>
          <Button onClick={() => setNonce(nonce + 1)}>إعادة المحاولة</Button>
        </div>
      ) : (
        <div class="state-frame" aria-busy="true">
          <span class="visually-hidden" role="status">
            جارٍ التحميل
          </span>
          <Skeleton blockSize="var(--fs-num)" inlineSize="40%" />
          <Skeleton inlineSize="90%" />
        </div>
      )}
    </Drawer>
  );
}
