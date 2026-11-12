import type { ComponentChildren } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';

import { discard, type OutboxEvent } from '../../sync/outbox';
import { Button } from '../../ui/Button';

/** What a save queued: the ids of its events, and what the form does when it is taken back. */
export interface SaveRecord {
  ids: string[];
  onUndone?(): void;
}

export interface SaveStatusProps {
  record: SaveRecord | null;
  /** The save was taken back before it was sent. */
  undone: boolean;
  pendingIds: ReadonlySet<string>;
  onUndo(): void;
}

/** One line under the form that tells what became of the last save. While every event of it still
 *  waits on this device, it can be taken back; once any was sent the line states that fact and
 *  offers nothing, because there is no «cancel» to send for a journal or a mood. */
export function SaveStatus({ record, undone, pendingIds, onUndo }: SaveStatusProps) {
  if (undone) {
    return (
      <p class="day-status" role="status">
        أُلغي الحفظ
      </p>
    );
  }
  if (record === null) return <p class="visually-hidden" role="status" />;
  const waiting = record.ids.filter((id) => pendingIds.has(id)).length;
  if (waiting === record.ids.length) {
    return (
      <p class="day-status" role="status">
        <span>حُفظ على الجهاز · لم يُرسل بعد</span>
        <Button onClick={onUndo}>تراجع</Button>
      </p>
    );
  }
  return (
    <p class="day-status" role="status">
      {waiting === 0 ? 'أُرسل الحفظ' : 'أُرسل بعض الحفظ · والباقي لم يُرسل بعد'}
    </p>
  );
}

/** The page's single save line: forms report their saves with `onSaved`, `node` draws the line. */
export function useSaveStatus(
  pending: readonly OutboxEvent[],
  refreshPending: () => Promise<void>,
): { onSaved(record: SaveRecord): Promise<void>; node: ComponentChildren } {
  const [record, setRecord] = useState<SaveRecord | null>(null);
  const [undone, setUndone] = useState(false);
  const pendingIds = useMemo(() => new Set(pending.map((e) => e.id)), [pending]);

  const onSaved = useCallback(
    async (next: SaveRecord): Promise<void> => {
      // Read the queue first: a line drawn before it knows the new events would say «sent».
      await refreshPending();
      setUndone(false);
      setRecord(next);
    },
    [refreshPending],
  );

  const onUndo = useCallback(async (): Promise<void> => {
    if (record === null) return;
    const results = await Promise.all(record.ids.map((id) => discard(id)));
    await refreshPending();
    if (results.every(Boolean)) {
      record.onUndone?.();
      setRecord(null);
      setUndone(true);
    }
    // Otherwise an event was sent a moment ago: the line now says so by itself.
  }, [record, refreshPending]);

  return {
    onSaved,
    node: <SaveStatus record={record} undone={undone} pendingIds={pendingIds} onUndo={() => void onUndo()} />,
  };
}
