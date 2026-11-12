// The note at the bottom of the window after a tap: what was logged, with «تراجع» while the log is
// still in the outbox, or the plain fact («أُرسل التسجيل؛ التصحيح بتخطي اليوم») when it is not.
//
// The note stays until the next logging action or until it is dismissed: a person on the keyboard
// needs time to reach it (WCAG 2.2.1), so no timer closes it. It is announced (the Toast is a
// polite live region), and after a tap made with the keyboard focus moves to «تراجع», then comes
// back to the habit when the note is used or dismissed.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type { UseHabitsToday } from '../../habits/useHabitsToday';

export const SENT_NOTE = 'أُرسل التسجيل؛ التصحيح بتخطي اليوم';

const PREFIX = { done: 'سُجّل', skip: 'سُجّل تخطّي اليوم', vacation: 'سُجّلت إجازة اليوم' } as const;

export interface LogNote {
  message: string;
  action: { label: string; onAction(): void } | undefined;
  dismiss(): void;
  /** A tap on a done row: takes an unsent log back, or says it was sent. */
  untick(code: string): void;
}

export function useLogNote(habits: Pick<UseHabitsToday, 'last' | 'clearLast' | 'undo' | 'release'>): LogNote {
  const { last, clearLast, undo, release } = habits;
  const [notice, setNotice] = useState('');
  const keyboard = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = () => {
      keyboard.current = true;
    };
    const onPointer = () => {
      keyboard.current = false;
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);

  const restoreFocus = useCallback(() => {
    const element = returnTo.current;
    returnTo.current = null;
    if (element?.isConnected) element.focus();
  }, []);

  // A new log replaces the note. After a keyboard tap, «تراجع» takes the focus.
  useEffect(() => {
    setNotice('');
    if (!last || !keyboard.current) return;
    const active = document.activeElement;
    if (returnTo.current === null && active instanceof HTMLElement && !active.closest('.toast')) {
      returnTo.current = active;
    }
    document.querySelector<HTMLElement>('.toast-action')?.focus();
  }, [last?.eventId]);

  const dismiss = useCallback(() => {
    clearLast();
    setNotice('');
    restoreFocus();
  }, [clearLast, restoreFocus]);

  const untick = useCallback(
    (code: string) => {
      void release(code).then((taken) => {
        if (!taken) setNotice(SENT_NOTE);
      });
    },
    [release],
  );

  const takeBack = (eventId: string) => {
    void undo(eventId).then((taken) => {
      if (!taken) setNotice(SENT_NOTE);
      restoreFocus();
    });
  };

  if (notice) return { message: notice, action: undefined, dismiss, untick };
  return {
    message: last ? `${PREFIX[last.status]}: ${last.title}` : '',
    action: last ? { label: 'تراجع', onAction: () => takeBack(last.eventId) } : undefined,
    dismiss,
    untick,
  };
}
