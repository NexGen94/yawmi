import { CloseButton } from './CloseButton';

export interface ToastProps {
  /** What just happened («أُرسل التسجيل»). An empty message keeps the live region mounted but
   *  shows nothing, so the next message is announced. */
  message: string;
  /** One follow-up action («تراجع»). */
  action?: { label: string; onAction(): void };
  /** Adds a close button. The toast never closes itself: the page decides when it goes. */
  onDismiss?(): void;
}

/** A short note at the bottom of the window, announced politely (role="status"). Keep it mounted
 *  and change `message`: a live region that appears together with its text is not always read. */
export function Toast({ message, action, onDismiss }: ToastProps) {
  return (
    <div class={message ? 'toast' : 'visually-hidden'} role="status" aria-live="polite">
      {message && (
        <>
          <p class="toast-message">{message}</p>
          {action && (
            <button type="button" class="toast-action" onClick={action.onAction}>
              {action.label}
            </button>
          )}
          {onDismiss && <CloseButton onClose={onDismiss} />}
        </>
      )}
    </div>
  );
}
