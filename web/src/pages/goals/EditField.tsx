import { useEffect, useId, useRef, useState } from 'preact/hooks';

import { DUE_OUT_OF_RANGE, EditError, FAILED_MESSAGE, OFFLINE_NOTE } from '../../goals/edits';
import { DASH } from '../../goals/format';
import { fmt } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Field } from '../../ui/Field';

interface Common {
  /** The name of the field («الموعد»). */
  label: string;
  /** Read aloud with the name, never drawn: what the field belongs to (the milestone's title). */
  context?: string;
  /** The shown value is an edit that Notion has not taken yet: «معلّق». */
  pending: boolean;
  /** No edit can be made now (no connection): the control is off and says «يحتاج اتصالاً». */
  disabled: boolean;
  /** The caller says the reason once for a group of fields. */
  quietOffline?: boolean;
}

export type EditFieldProps = Common &
  (
    | { kind: 'toggle'; value: boolean; onSave(value: boolean): Promise<void> }
    | { kind: 'date'; value: string | null; min?: string; max?: string; onSave(value: string): Promise<void> }
    | { kind: 'text'; value: string | null; maxLength?: number; onSave(value: string): Promise<void> }
    | {
        kind: 'select';
        value: string | null;
        options: readonly { value: string; label: string }[];
        onSave(value: string): Promise<void>;
      }
  );

/** What the field says when the save did not happen: the sentence of an `EditError`, else a general one. */
const messageOf = (error: unknown): string => (error instanceof EditError && error.message ? error.message : FAILED_MESSAGE);

/** One value of a goal that can be edited here (design 4, «المحطات بحقول قابلة للتعديل», and 11). A date
 *  or a text is shown, and «تعديل» opens it with «حفظ» and «إلغاء»; a toggle and a choice save when they
 *  change. Saving is a request: the field is busy while it goes, and a refusal stays beside it with the
 *  value as it was. `onSave` rejects (with an `EditError`) to say it did not happen. */
export function EditField(props: EditFieldProps) {
  const { label, context, pending, disabled, quietOffline } = props;
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // The value a toggle was given, kept on screen until its save settles (the plan is read again meanwhile).
  const [held, setHeld] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const openButton = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Focus goes into the field when it opens, and back to «تعديل» when it closes.
  useEffect(() => {
    if (editing) form.current?.querySelector<HTMLElement>('input, textarea')?.focus();
    else if (wasEditing.current) openButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  /** Runs the save; true when it went through. */
  const run = async (save: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await save();
      return true;
    } catch (failure: unknown) {
      if (alive.current) setError(messageOf(failure));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const off = disabled || busy;
  const named = context ? `${label}: ${context}` : label;
  const note = disabled && !quietOffline && (
    <span class="edit-offline">{OFFLINE_NOTE}</span>
  );
  const badge = pending && <Badge>معلّق</Badge>;
  const alert = error !== '' && (
    <p class="edit-error" role="alert">
      {error}
    </p>
  );

  if (props.kind === 'toggle') {
    const { value, onSave } = props;
    return (
      <div class="edit-field edit-toggle">
        <label class="edit-toggle-label">
          <input
            type="checkbox"
            checked={held ?? value}
            disabled={off}
            onChange={(event) => {
              const next = event.currentTarget.checked;
              setHeld(next);
              void run(() => onSave(next)).finally(() => {
                if (alive.current) setHeld(null);
              });
            }}
          />
          <span>{label}</span>
          {context && <span class="visually-hidden">{`: ${context}`}</span>}
        </label>
        {badge}
        {note}
        {alert}
      </div>
    );
  }

  if (props.kind === 'select') {
    const { value, options, onSave } = props;
    return (
      <div class="edit-field edit-select">
        <label class="edit-label" for={id}>
          {label}
          {context && <span class="visually-hidden">{`: ${context}`}</span>}
        </label>
        <select
          id={id}
          class="field-input edit-select-input"
          value={value ?? ''}
          disabled={off}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (next !== (value ?? '')) void run(() => onSave(next));
          }}
        >
          {value === null && <option value="">{DASH}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {badge}
        {note}
        {alert}
      </div>
    );
  }

  const { value, onSave } = props;
  const shown = value === null || value === '' ? DASH : props.kind === 'date' ? fmt.day(value) : value;
  const open = (): void => {
    setDraft(value ?? '');
    setError('');
    setEditing(true);
  };
  const close = (): void => {
    setEditing(false);
    setError('');
  };
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (props.kind === 'date' && draft === '') {
      setError('اختيار تاريخ مطلوب.');
      return;
    }
    if (props.kind === 'date' && ((props.min !== undefined && draft < props.min) || (props.max !== undefined && draft > props.max))) {
      setError(DUE_OUT_OF_RANGE);
      return;
    }
    if (draft === (value ?? '')) {
      close();
      return;
    }
    if (await run(() => onSave(draft))) close();
  };

  if (editing) {
    return (
      <form class="edit-field edit-form" noValidate ref={form} onSubmit={(event) => void submit(event)} onKeyDown={(event) => event.key === 'Escape' && close()}>
        <Field
          label={label}
          type={props.kind === 'date' ? 'date' : 'text'}
          multiline={props.kind === 'text'}
          value={draft}
          onInput={setDraft}
          disabled={busy}
          min={props.kind === 'date' ? props.min : undefined}
          max={props.kind === 'date' ? props.max : undefined}
          maxLength={props.kind === 'text' ? props.maxLength : undefined}
        />
        {alert}
        <div class="edit-actions">
          <button type="submit" class="btn btn-primary" disabled={busy}>
            حفظ
          </button>
          <button type="button" class="btn btn-quiet" disabled={busy} onClick={close}>
            إلغاء
          </button>
        </div>
      </form>
    );
  }

  return (
    <div class="edit-field">
      <span class="edit-label">{label}</span>
      <span class="edit-value">{props.kind === 'date' ? <bdi>{shown}</bdi> : shown}</span>
      {badge}
      <button type="button" class="edit-open" ref={openButton} aria-label={`تعديل ${named}`} disabled={off} onClick={open}>
        تعديل
      </button>
      {note}
      {alert}
    </div>
  );
}
