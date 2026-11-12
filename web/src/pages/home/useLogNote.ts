// The note at the bottom of the window after a tap: what was logged, with «تراجع» while the log is
// still in the outbox, or the plain fact («أُرسل التسجيل؛ التصحيح بتخطي اليوم») when it is not.
//
// The note stays until the next logging action or until it is dismissed: a person on the keyboard
// needs time to reach it (WCAG 2.2.1), so no timer closes it. It is announced (the Toast is a
// polite live region) and its buttons are in the tab order, but focus never leaves the habit that
// was logged: moving it to «تراجع» after every keyboard tap would pull a person out of a list
// they are working through. Escape dismisses the note from wherever focus is. When the note is used
// from the keyboard («تراجع», ×, Escape) its button goes away with it, so focus is given back to
// the element that held it when the log was made, instead of falling to the page body.

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
  // The element that held focus outside the note when the log was made (the habit's row).
  const returnTo = useRef<HTMLElement | null>(null);
  // Set when the note is used while one of its own buttons has focus: that button is about to go.
  const giveBack = useRef(false);

  // Follows focus as it moves, so the element is known the moment the log is made, not when an
  // effect gets to run.
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('.toast')) return;
      returnTo.current = target;
      giveBack.current = false; // focus is on the page again: nothing to give back
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);
  const noteHasFocus = (): boolean => Boolean(document.activeElement?.closest('.toast'));

  // A new log replaces the note.
  useEffect(() => {
    setNotice('');
  }, [last?.eventId]);

  // After the render that removed the note's button, focus that fell to the body goes back.
  useEffect(() => {
    if (!giveBack.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    giveBack.current = false;
    if (returnTo.current?.isConnected) returnTo.current.focus();
  });

  // Escape dismisses the note from anywhere. The listener lives as long as the page, and reads
  // through a ref whether a note is showing, so it never misses a note that has just appeared.
  const showing = useRef(false);
  showing.current = Boolean(notice) || last !== null;
  const clearRef = useRef(clearLast);
  clearRef.current = clearLast;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !showing.current) return;
      giveBack.current = noteHasFocus();
      clearRef.current();
      setNotice('');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const dismiss = useCallback(() => {
    giveBack.current = noteHasFocus();
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
    giveBack.current = noteHasFocus();
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
