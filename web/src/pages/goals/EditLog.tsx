import { useState } from 'preact/hooks';

import { EditError, FAILED_MESSAGE, isReplaced, OFFLINE_NOTE } from '../../goals/edits';
import { DASH, editedDay, fieldLabel } from '../../goals/format';
import { fmt } from '../../lib/format';
import { Iso } from '../../goals/Iso';
import type { GoalEditOut } from '../../goals/types';
import { Badge } from '../../ui/Badge';
import { Skeleton } from '../../ui/Skeleton';

/** The six states of an edit, in words (design 11). */
export const STATUS_WORDS: Record<GoalEditOut['status'], string> = {
  pending: 'معلّق',
  applied: 'طُبّق على Notion',
  conflict: 'متعارض مع Notion',
  failed: 'تعذّر التطبيق على Notion',
  superseded: 'أُزيح بتعديل أحدث',
  cancelled: 'ملغى',
};

const STATUS_HINTS: Partial<Record<GoalEditOut['status'], string>> = {
  conflict: 'تغيّرت القيمة في Notion بعد التعديل، فلم يُطبَّق.',
  superseded: 'حلّ محلّه تعديل أحدث للحقل نفسه.',
  failed: 'لم يُطبَّق؛ يمكن تعديل الحقل من جديد',
};

/** A value of an edit as the log says it: a day in words, a boolean as its state. */
export function valueText(value: GoalEditOut['new_value']): string {
  if (typeof value === 'boolean') return value ? 'منجزة' : 'مفتوحة';
  if (value === null || value === '') return DASH;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? fmt.day(value) : value;
}

export interface EditLogProps {
  /** The edits of this goal, newest first. `undefined` while the first reading is still coming. */
  items: GoalEditOut[] | undefined;
  /** Every edit the server listed, to tell which a newer one has taken the place of. */
  all: GoalEditOut[] | undefined;
  state: 'loading' | 'ready' | 'error' | 'offline';
  /** The titles of the milestones and cards, by page. */
  titles: Map<string, string>;
  online: boolean;
  onCancel(edit: GoalEditOut): Promise<void>;
  onRedo(edit: GoalEditOut): Promise<void>;
}

function Entry({ edit, replaced, titles, online, onCancel, onRedo }: { edit: GoalEditOut; replaced: boolean } & Omit<EditLogProps, 'items' | 'all' | 'state'>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = (edit.status === 'pending' || edit.status === 'conflict') && !replaced;
  const act = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (failure: unknown) {
      setError(failure instanceof EditError && failure.message ? failure.message : FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  };
  const hint = STATUS_HINTS[edit.status];
  return (
    <li class="log-row" data-edit={edit.id} data-status={edit.status}>
      <div class="log-head">
        <span class="log-what">
          {titles.get(edit.page_id) ?? edit.page_id} · {fieldLabel(edit.field)}
        </span>
        <Badge tone={edit.status === 'conflict' || edit.status === 'failed' ? 'signal' : 'neutral'}>{STATUS_WORDS[edit.status]}</Badge>
      </div>
      <p class="log-change">
        <Iso text={`من «${valueText(edit.old_value)}» إلى «${valueText(edit.new_value)}»`} />
      </p>
      <p class="log-meta">{editedDay(edit.created_at)}</p>
      {hint && <p class="log-meta">{hint}</p>}
      {open && (
        <div class="log-actions">
          {edit.status === 'conflict' && (
            <button
              type="button"
              class="btn btn-quiet"
              disabled={!online || busy}
              aria-label={`إعادة التعديل: ${titles.get(edit.page_id) ?? ''} · ${fieldLabel(edit.field)}`}
              onClick={() => void act(() => onRedo(edit))}
            >
              إعادة التعديل
            </button>
          )}
          <button
            type="button"
            class="btn btn-quiet"
            disabled={!online || busy}
            aria-label={`إلغاء التعديل: ${titles.get(edit.page_id) ?? ''} · ${fieldLabel(edit.field)}`}
            onClick={() => void act(() => onCancel(edit))}
          >
            إلغاء
          </button>
          {!online && <span class="edit-offline">{OFFLINE_NOTE}</span>}
        </div>
      )}
      {error !== '' && (
        <p class="edit-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** What was changed from here and where it stands (design 11): every edit of this goal in one of six
 *  states. A pending or a conflicting edit can be cancelled; a conflicting one can also be made again
 *  (a new `PATCH` with the same value, which reads the base value anew). Nothing is deleted. */
export function EditLog({ items, all, state, titles, online, onCancel, onRedo }: EditLogProps) {
  if (items === undefined) {
    if (state === 'loading') return <Skeleton blockSize="var(--hit)" />;
    return <p class="gd-none">{state === 'offline' ? 'السجل يحتاج اتصالاً.' : 'تعذّر تحميل السجل.'}</p>;
  }
  if (items.length === 0) return <p class="gd-none">لا تعديلات بعد.</p>;
  return (
    <ul class="log-list">
      {items.map((edit) => (
        <Entry key={edit.id} edit={edit} replaced={isReplaced(edit, all ?? items)} titles={titles} online={online} onCancel={onCancel} onRedo={onRedo} />
      ))}
    </ul>
  );
}
