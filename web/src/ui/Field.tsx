import type { InputHTMLAttributes } from 'preact';
import { useId } from 'preact/hooks';

export type FieldType = 'text' | 'number' | 'date' | 'time';

export interface FieldProps {
  label: string;
  value: string;
  /** The raw text of the field after each keystroke; numbers stay text until the page parses them. */
  onInput(value: string): void;
  /** text (default), number, date or time. Ignored when `multiline`. */
  type?: FieldType;
  /** A textarea for free text (the journal). */
  multiline?: boolean;
  /** A line under the field that says what goes in it. */
  hint?: string;
  /** What is wrong and how to fix it; marks the field invalid. */
  error?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  autoComplete?: string;
}

/** A labelled field. The border is --c-blue, because it carries meaning (design 5.1). */
export function Field(props: FieldProps) {
  const { label, value, onInput, type = 'text', multiline, hint, error, ...rest } = props;
  const id = useId();
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  const shared = {
    ...rest,
    id,
    value,
    'aria-invalid': error ? ('true' as const) : undefined,
    'aria-describedby': described,
  };
  // One component for four input types: the attribute union of Preact cannot follow a runtime
  // type, so the props are assembled here and typed once.
  const inputProps = {
    ...shared,
    type,
    class: 'field-input',
    inputMode: type === 'number' ? 'decimal' : undefined,
    onInput: (event: Event) => onInput((event.currentTarget as HTMLInputElement).value),
  } as InputHTMLAttributes<HTMLInputElement>;
  return (
    <div class="field">
      <label class="field-label" for={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          {...shared}
          class="field-input field-textarea"
          rows={4}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
      ) : (
        <input {...inputProps} />
      )}
      {hint && (
        <p id={`${id}-hint`} class="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} class="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
