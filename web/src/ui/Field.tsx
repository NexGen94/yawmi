import type { InputHTMLAttributes } from 'preact';
import { useId } from 'preact/hooks';

import { fmt } from '../lib/format';

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
  /** The longest text the field takes. It is the control's own `maxlength`, a longer input (a
   *  script, an input method) is cut to it, and a count «n / max» shows once 80% is used. */
  maxLength?: number;
}

/** From this share of the limit the count shows: before it, it would only be noise. */
const COUNT_FROM = 0.8;

/** A labelled field. The border is --c-blue, because it carries meaning (design 5.1). */
export function Field(props: FieldProps) {
  const { label, value, onInput, type = 'text', multiline, hint, error, maxLength, ...rest } = props;
  const id = useId();
  const counted = maxLength !== undefined && value.length >= maxLength * COUNT_FROM ? maxLength : null;
  const described =
    [hint && `${id}-hint`, counted !== null && `${id}-count`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  const take = (el: HTMLInputElement | HTMLTextAreaElement): void => {
    if (maxLength !== undefined && el.value.length > maxLength) el.value = el.value.slice(0, maxLength);
    onInput(el.value);
  };
  const shared = {
    ...rest,
    id,
    value,
    maxLength,
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
    onInput: (event: Event) => take(event.currentTarget as HTMLInputElement),
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
          onInput={(event) => take(event.currentTarget)}
        />
      ) : (
        <input {...inputProps} />
      )}
      {hint && (
        <p id={`${id}-hint`} class="field-hint">
          {hint}
        </p>
      )}
      {counted !== null && (
        <p id={`${id}-count`} class="field-count">
          {fmt.num(value.length)} / {fmt.num(counted)}
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
