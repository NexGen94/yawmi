import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';
import { discard, type OutboxEvent, type QuarantinedEvent, requeue, scheduleFlush } from '../../sync/outbox';
import { Button } from '../../ui/Button';
import type { DayPart } from './part';
import { refusalReason } from './refusal';

/** What a save queued: the ids of its events, which day and side it was for, and what the form
 *  does when the save is taken back or refused. */
export interface SaveRecord {
  ids: string[];
  day: Day;
  part: DayPart;
  onUndone?(): void;
  /** The ids the server refused. */
  onRefused?(refusedIds: ReadonlySet<string>): void;
}

/** `waiting`: all on this device. `accepted`: the server has them. `refused`: the server said no
 *  to at least one (the outbox kept it apart). `partial`: some sent, some still waiting. */
export type SaveOutcome = 'waiting' | 'accepted' | 'refused' | 'partial';

/** «No longer in the queue» is not «sent»: a refusal leaves the queue too, into quarantine. */
export function saveOutcome(
  ids: readonly string[],
  pendingIds: ReadonlySet<string>,
  refusedIds: ReadonlySet<string>,
): SaveOutcome {
  if (ids.some((id) => refusedIds.has(id))) return 'refused';
  const waiting = ids.filter((id) => pendingIds.has(id)).length;
  if (waiting === ids.length) return 'waiting';
  return waiting === 0 ? 'accepted' : 'partial';
}

interface SaveStatusProps {
  record: SaveRecord;
  outcome: SaveOutcome;
  /** The reason of the refusal, in Arabic. */
  reason: string;
  /** The save is for a day other than today: the line names it. */
  dayLabel: string | null;
  onUndo(): void;
  onRetry(): void;
}

/** One line under the form that tells what became of the last save. While every event of it still
 *  waits on this device it can be taken back. Once the server has it, the line states that and
 *  offers nothing. When the server refused it, the line says so with the reason: the text is still
 *  on the device and can be sent again. */
function SaveStatus({ outcome, reason, dayLabel, onUndo, onRetry }: SaveStatusProps) {
  const forDay = dayLabel === null ? '' : ` ليوم ${dayLabel}`;
  switch (outcome) {
    case 'waiting':
      return (
        <p class="day-status" role="status">
          <span>{`حُفظ${forDay} على الجهاز · لم يُرسل بعد`}</span>
          <Button onClick={onUndo}>تراجع</Button>
        </p>
      );
    case 'accepted':
      return (
        <p class="day-status" role="status">
          أُرسل الحفظ
        </p>
      );
    case 'refused':
      return (
        <p class="day-status day-status-refused" role="alert">
          <span>{`تعذّر الحفظ${forDay} · ${reason} · النص محفوظ على الجهاز`}</span>
          <Button onClick={onRetry}>إعادة المحاولة</Button>
        </p>
      );
    case 'partial':
      return (
        <p class="day-status" role="status">
          أُرسل بعض الحفظ · والباقي لم يُرسل بعد
        </p>
      );
  }
}

export interface SaveStatusArgs {
  pending: readonly OutboxEvent[];
  quarantine: readonly QuarantinedEvent[];
  refreshPending(): Promise<void>;
  /** The side and the day on screen: the line belongs to its own side. */
  part: DayPart;
  viewDay: Day;
  today: Day;
}

/** The page's single save line: forms report their saves with `onSaved`, `node` draws the line,
 *  and only for the side it belongs to (a morning save is not shown under the evening). */
export function useSaveStatus(args: SaveStatusArgs): { onSaved(record: SaveRecord): Promise<void>; node: ComponentChildren } {
  const { pending, quarantine, refreshPending, part, viewDay, today } = args;
  const [last, setLast] = useState<{ record: SaveRecord; undone: boolean } | null>(null);
  const pendingIds = useMemo(() => new Set(pending.map((e) => e.id)), [pending]);
  const refused = useMemo(() => new Map(quarantine.map((e) => [e.id, e])), [quarantine]);
  const refusedIds = useMemo(() => new Set(refused.keys()), [refused]);

  const record = last?.record ?? null;
  const outcome = record === null ? null : saveOutcome(record.ids, pendingIds, refusedIds);

  // Tell the form once when its save was refused (a mood form then lets it be logged again).
  const told = useRef<SaveRecord | null>(null);
  useEffect(() => {
    if (record !== null && outcome === 'refused' && told.current !== record) {
      told.current = record;
      record.onRefused?.(refusedIds);
    }
  }, [record, outcome, refusedIds]);

  const onSaved = useCallback(
    async (next: SaveRecord): Promise<void> => {
      // Read the queue first: a line drawn before it knows the new events would say «sent».
      await refreshPending();
      setLast({ record: next, undone: false });
    },
    [refreshPending],
  );

  const onUndo = useCallback(async (): Promise<void> => {
    if (record === null) return;
    const results = await Promise.all(record.ids.map((id) => discard(id)));
    await refreshPending();
    if (results.every(Boolean)) {
      record.onUndone?.();
      setLast({ record, undone: true });
    }
    // Otherwise an event was sent a moment ago: the line now says so by itself.
  }, [record, refreshPending]);

  const onRetry = useCallback(async (): Promise<void> => {
    if (record === null) return;
    await Promise.all(record.ids.filter((id) => refusedIds.has(id)).map((id) => requeue(id)));
    scheduleFlush(0);
    await refreshPending();
  }, [record, refusedIds, refreshPending]);

  // The line belongs to its side. A line about another day goes once the server has accepted it.
  const visible = record !== null && record.part === part && (record.day === viewDay || outcome !== 'accepted');

  let node: ComponentChildren = <p class="visually-hidden" role="status" />;
  if (visible && last !== null && record !== null && outcome !== null) {
    if (last.undone) {
      node = (
        <p class="day-status" role="status">
          أُلغي الحفظ
        </p>
      );
    } else {
      const firstRefused = record.ids.map((id) => refused.get(id)).find((e) => e !== undefined);
      node = (
        <SaveStatus
          record={record}
          outcome={outcome}
          reason={refusalReason(firstRefused?.errors ?? [])}
          dayLabel={record.day === today ? null : fmt.day(record.day)}
          onUndo={() => void onUndo()}
          onRetry={() => void onRetry()}
        />
      );
    }
  }
  return { onSaved, node };
}
