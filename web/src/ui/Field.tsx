import type { InputHTMLAttributes } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

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
  /** The keyboard a phone offers; a number field is `decimal` unless this says otherwise. */
  inputMode?: 'text' | 'numeric' | 'decimal';
  /** The longest text the field takes. It is the control's own `maxlength`, a longer input (a
   *  script, an input method) is cut to it, and a count «n / max» shows once 80% is used. */
  maxLength?: number;
}

const INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN = '۰۱۲۳۴۵۶۷۸۹';

/** Latin digits for whatever digits were typed (the Arabic-Indic and the Persian ones too). */
function latin(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => String(INDIC.includes(d) ? INDIC.indexOf(d) : EASTERN.indexOf(d)));
}

/** What a date or time field reports for the text typed: the value once the text is a real one («08:05»,
 *  «2026-12-08»), an empty string until then, as the browser's own control did. */
function entered(type: 'date' | 'time', text: string): string {
  const typed = latin(text.trim());
  if (type === 'time') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(typed);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
    return `${(m[1] as string).padStart(2, '0')}:${m[2]}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typed);
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? typed : '';
}

function defaultInputMode(type: FieldType): 'decimal' | 'numeric' | undefined {
  if (type === 'number') return 'decimal';
  return type === 'date' || type === 'time' ? 'numeric' : undefined;
}

/** The draft of a date or time field: what is on screen while it is typed, and the value the page is
 *  told (`entered`). A value the page changes on its own (a chip fills «إلى») shows at once. */
function useTypedText(value: string, kind: 'date' | 'time' | null, onInput: (value: string) => void) {
  const [draft, setDraft] = useState(value);
  const told = useRef(value);
  const external = value !== told.current;
  useEffect(() => {
    if (external) {
      told.current = value;
      setDraft(value);
    }
  });
  return {
    props: (placeholder: string, given: string | undefined) => ({
      dir: 'ltr',
      value: external ? value : draft,
      placeholder: given ?? placeholder,
      autoComplete: 'off',
      min: undefined,
      max: undefined,
      step: undefined,
      onInput: (event: Event) => {
        const text = (event.currentTarget as HTMLInputElement).value;
        setDraft(text);
        const out = kind === null ? text : entered(kind, text);
        told.current = out;
        onInput(out);
      },
    }),
  };
}

/** From this share of the limit the count shows: before it, it would only be noise. */
const COUNT_FROM = 0.8;

/** A labelled field. The border is --c-blue, because it carries meaning (design 5.1). */
export function Field(props: FieldProps) {
  const { label, value, onInput, type = 'text', multiline, hint, error, maxLength, ...rest } = props;
  const id = useId();
  // A date or a time is typed as text, so the page speaks Arabic and 24 hours (see `entered`).
  const textual = type === 'date' || type === 'time';
  const typed = useTypedText(value, textual ? (type as 'date' | 'time') : null, onInput);
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
    type: textual ? 'text' : type,
    class: 'field-input',
    inputMode: rest.inputMode ?? defaultInputMode(type),
    onInput: (event: Event) => take(event.currentTarget as HTMLInputElement),
    ...(textual ? typed.props(type === 'time' ? 'ساعة:دقيقة' : 'سنة-شهر-يوم', rest.placeholder) : {}),
  } as InputHTMLAttributes<HTMLInputElement>;
  const echo = type === 'date' && value !== '' && entered('date', value) !== '' ? fmt.day(value) : null;
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
      {echo !== null && <p class="field-hint field-echo">{echo}</p>}
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
