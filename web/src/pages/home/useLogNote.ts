// The note at the bottom of the window after a tap: what was logged, with «تراجع» while the log is
// still in the outbox, or the plain fact («أُرسل التسجيل؛ التصحيح بتخطي اليوم») when it is not.
//
// The note stays until the next logging action or until it is dismissed: a person on the keyboard
// needs time to reach it (WCAG 2.2.1), so no timer closes it. It is announced (the Toast is a
// polite live region) and its buttons are in the tab order, but focus never leaves the habit that
// was logged: moving it to «تراجع» after every keyboard tap would pull a person out of a list
// they are working through. Escape dismisses the note from wherever focus is.

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
  // A new log replaces the note.
  useEffect(() => {
    setNotice('');
  }, [last?.eventId]);

  // Escape dismisses the note from anywhere. The listener lives as long as the page, and reads
  // through a ref whether a note is showing, so it never misses a note that has just appeared.
  const showing = useRef(false);
  showing.current = Boolean(notice) || last !== null;
  const clearRef = useRef(clearLast);
  clearRef.current = clearLast;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !showing.current) return;
      clearRef.current();
      setNotice('');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const dismiss = useCallback(() => {
    clearLast();
    setNotice('');
  }, [clearLast]);

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
