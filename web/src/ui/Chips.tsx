import type { Option } from './Segmented';

export interface ChipsProps<T extends string> {
  /** Names the group for screen readers («المشاعر», «الأنشطة»). */
  label: string;
  options: readonly Option<T>[];
  selected: readonly T[];
  /** The new selection, in the order of `options`. */
  onChange(next: T[]): void;
}

/** Several independent choices: each chip is a toggle button (aria-pressed) and shows a check mark
 *  when on, so the state is not told by colour alone. For one choice among a few, use Segmented. */
export function Chips<T extends string>({ label, options, selected, onChange }: ChipsProps<T>) {
  const toggle = (value: T): void => {
    const on = selected.includes(value);
    onChange(options.map((o) => o.value).filter((v) => (v === value ? !on : selected.includes(v))));
  };
  return (
    <div class="chips" role="group" aria-label={label}>
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            class="chip"
            aria-pressed={on ? 'true' : 'false'}
            onClick={() => toggle(option.value)}
          >
            {on && (
              <svg class="chip-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" />
              </svg>
            )}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
