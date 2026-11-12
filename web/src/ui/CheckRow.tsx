import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';

export interface CheckRowProps {
  checked: boolean;
  /** The row's name (a habit, a priority). */
  label: string;
  /** A second line under the label (the identity sentence, the period progress). */
  note?: string;
  /** Read aloud with the row, never drawn: what a press will do (the state alone cannot say). */
  hint?: string;
  /** Shown at the end of the row, usually a Badge with the outcome code. */
  badge?: ComponentChildren;
  /** circle for a habit (default), square for a priority. */
  shape?: 'circle' | 'square';
  disabled?: boolean;
  onToggle(next: boolean): void;
}

/** A row that is one toggle button (aria-pressed). Done draws a check mark in the 44px mark, so
 *  the state never rests on colour alone. The name is everything the row shows (label, note,
 *  badge), so the words on the button are in its name (WCAG 2.5.3); the hint is the description. */
export function CheckRow({ checked, label, note, hint, badge, shape = 'circle', disabled, onToggle }: CheckRowProps) {
  const id = useId();
  const named = [`${id}-label`, note && `${id}-note`, badge && `${id}-badge`].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      class="check-row"
      aria-pressed={checked ? 'true' : 'false'}
      aria-labelledby={named}
      aria-describedby={hint ? `${id}-hint` : undefined}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
    >
      <span class={`check-mark check-${shape}`} aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          {checked && <path d="M5.5 12.5l4.25 4.25L18.5 8" fill="none" stroke="currentColor" />}
        </svg>
      </span>
      <span class="check-text">
        <span id={`${id}-label`} class="check-label">
          {label}
        </span>
        {/* The spaces are in the text too, not only in the layout: the visible words then read
            as the name does (axe compares the two as text). */}
        {note && ' '}
        {note && (
          <span id={`${id}-note`} class="check-note">
            {note}
          </span>
        )}
      </span>
      {badge && ' '}
      {hint && (
        <span id={`${id}-hint`} class="visually-hidden">
          {hint}
        </span>
      )}
      {badge && (
        <span id={`${id}-badge`} class="check-badge">
          {badge}
        </span>
      )}
    </button>
  );
}
