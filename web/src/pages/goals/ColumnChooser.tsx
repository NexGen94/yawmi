import { useState } from 'preact/hooks';

import { GOAL_COLUMNS, type GoalTable, TABLE_LABELS } from '../../goals/columns';
import { Disclosure } from '../../ui/Disclosure';

export interface ColumnChooserProps {
  table: GoalTable;
  /** The columns the table shows now, in order. */
  shown: readonly string[];
  /** The browser is online. */
  online: boolean;
  /** The stored choice is known (a change is saved with the other two tables as they are). */
  known: boolean;
  /** The stored choice is still being read. */
  loading: boolean;
  /** Saves the new list. True when the server took it. */
  onSave(keys: string[]): Promise<boolean>;
}

/** Why a choice cannot be saved now: no connection, still reading, or the stored choice failed to load. */
function reasonFor(online: boolean, loading: boolean): string {
  if (!online) return 'يحتاج اتصالاً';
  return loading ? 'جارٍ تحميل الأعمدة' : 'تعذّر تحميل الأعمدة';
}

/** Which columns of a table are shown: one toggle per field of the row model. A choice is saved at once,
 *  so it needs the connection. A column that is switched on goes to the end; the last one stays. */
export function ColumnChooser({ table, shown, online, known, loading, onSave }: ColumnChooserProps) {
  const enabled = online && known;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async (key: string): Promise<void> => {
    if (busy) return;
    const next = shown.includes(key) ? shown.filter((k) => k !== key) : [...shown, key];
    setBusy(true);
    setFailed(false);
    const ok = await onSave(next);
    setFailed(!ok);
    setBusy(false);
  };

  return (
    <Disclosure summary="الأعمدة">
      <fieldset class="chips column-chips" aria-label={`أعمدة ${TABLE_LABELS[table]}`}>
        {GOAL_COLUMNS[table].map((column) => {
          const on = shown.includes(column.key);
          const last = on && shown.length === 1;
          return (
            <button
              key={column.key}
              type="button"
              class="chip"
              aria-pressed={on ? 'true' : 'false'}
              disabled={!enabled || last}
              onClick={() => void toggle(column.key)}
            >
              {on && (
                <svg class="chip-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" />
                </svg>
              )}
              {column.label}
            </button>
          );
        })}
      </fieldset>
      {!enabled && <p class="column-note">{reasonFor(online, loading)}</p>}
      {failed && (
        <p class="column-note column-note-error" role="alert">
          تعذّر حفظ الأعمدة
        </p>
      )}
    </Disclosure>
  );
}
