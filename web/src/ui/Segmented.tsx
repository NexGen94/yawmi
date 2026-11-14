import type { TargetedKeyboardEvent } from 'preact';

import { rowStep } from './direction';

export interface Option<T extends string> {
  value: T;
  label: string;
  /** This option cannot be chosen (the others can). */
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  /** Names the group for screen readers («المدى», «العرض»). */
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange(value: T): void;
  /** The choice is shown but cannot be changed (a locked field). */
  disabled?: boolean;
}

/** Up to this many options are one track; more are separate chips that wrap (Task 24: a track of
 *  five or six wrapped inside its pill and clipped its labels at 390). */
const MAX_TRACK = 4;

/** One choice among a few, as a radio group: one Tab stop, arrow keys move and select (in the
 *  visual direction: ArrowLeft goes forward in RTL), Home and End jump to the ends. The selected
 *  segment is white with a blue border. */
export function Segmented<T extends string>({ label, options, value, onChange, disabled = false }: SegmentedProps<T>) {
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const onKeyDown = (event: TargetedKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (disabled) return;
    const n = options.length;
    let next: number;
    if (event.key === 'Home' || event.key === 'End') {
      // The ends of the enabled options: a disabled one is never where the keys land.
      const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
      const end = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1];
      if (end === undefined) return;
      next = end;
    } else {
      const step = rowStep(event.key, event.currentTarget);
      if (step === 0) return;
      next = (index + step + n) % n;
      // A disabled option is not a stop: go on to the next enabled one (or stay when there is none).
      for (let tries = 0; options[next]?.disabled && tries < n; tries++) next = (next + step + n) % n;
      if (options[next]?.disabled) return;
    }
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[next]?.focus();
  };

  return (
    <div class={options.length > MAX_TRACK ? 'segmented segmented-chips' : 'segmented'} role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          class="segment"
          disabled={disabled || option.disabled}
          aria-checked={i === selected && option.value === value ? 'true' : 'false'}
          tabIndex={i === selected ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, i)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
