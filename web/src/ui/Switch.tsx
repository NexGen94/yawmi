import { useId } from 'preact/hooks';

export interface SwitchProps {
  checked: boolean;
  onChange(next: boolean): void;
  /** What the switch is: the name of the control. */
  label: string;
  /** One line under the label that says what it does (it describes the control). */
  hint?: string;
  disabled?: boolean;
}

/** An on-off setting as a row: the track and the label together, 44 px tall, never a button that
 *  looks like an action. Off is a white track with a blue knob at the inline start; on is an ink
 *  track with a light knob at the inline end. */
export function Switch({ checked, onChange, label, hint, disabled }: SwitchProps) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={checked ? 'true' : 'false'}
      aria-labelledby={`${id}-label`}
      aria-describedby={hint === undefined ? undefined : `${id}-hint`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span class="switch-track" aria-hidden="true">
        <span class="switch-thumb" />
      </span>
      <span class="switch-text">
        <span id={`${id}-label`} class="switch-label">
          {label}
        </span>
        {hint !== undefined && (
          <span id={`${id}-hint`} class="switch-hint">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}
