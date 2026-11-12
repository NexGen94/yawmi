import type { TargetedKeyboardEvent } from 'preact';

import { rowStep } from './direction';

export interface Option<T extends string> {
  value: T;
  label: string;
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

/** One choice among a few, as a radio group: one Tab stop, arrow keys move and select (in the
 *  visual direction: ArrowLeft goes forward in RTL), Home and End jump to the ends. The selected
 *  segment is the ink capsule. */
export function Segmented<T extends string>({ label, options, value, onChange, disabled = false }: SegmentedProps<T>) {
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const onKeyDown = (event: TargetedKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (disabled) return;
    const n = options.length;
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = n - 1;
    else {
      const step = rowStep(event.key, event.currentTarget);
      if (step === 0) return;
      next = (index + step + n) % n;
    }
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[next]?.focus();
  };

  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          class="segment"
          disabled={disabled}
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
