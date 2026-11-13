import type { ComponentChildren } from 'preact';

export interface LockedGroupProps {
  /** The visible name of the group; the control inside names itself for screen readers. */
  label: string;
  /** The controls inside are switched off (they take `disabled` themselves); the hint shows. */
  locked?: boolean;
  /** Said under the group when it is locked, or when an error needs the same place. */
  hint?: string;
  error?: string;
  children: ComponentChildren;
}

/** A labelled group of controls (a segmented choice, chips) with the lock and the error of a field. */
export function LockedGroup({ label, locked = false, hint, error, children }: LockedGroupProps) {
  return (
    <div class="field editor-group">
      <span class="field-label" aria-hidden="true">
        {label}
      </span>
      {children}
      {locked && hint && <p class="field-hint">{hint}</p>}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
