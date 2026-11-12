// «الأقرب استحقاقاً»: the open milestones with a date, the late ones first. Pure, so the horizons and the
// due report read the same days.

import { toOrdinal } from '../domain/days';
import type { Day } from '../domain/types';
import { fmt } from '../lib/format';
import type { MilestoneFull } from './types';

export interface DueItem {
  milestone: MilestoneFull;
  /** Days from today to the due day: negative once it is late. */
  offset: number;
}

/** Open milestones with a due date, split into late (most late first) and coming (nearest first). */
export function dueReport(milestones: readonly MilestoneFull[], today: Day): { overdue: DueItem[]; upcoming: DueItem[] } {
  const now = toOrdinal(today);
  const items: DueItem[] = milestones.flatMap((milestone) =>
    milestone.done || milestone.due_date === null ? [] : [{ milestone, offset: toOrdinal(milestone.due_date) - now }],
  );
  const byDate = (a: DueItem, b: DueItem): number => a.offset - b.offset;
  return {
    overdue: items.filter((i) => i.offset < 0).sort(byDate),
    upcoming: items.filter((i) => i.offset >= 0).sort(byDate),
  };
}

/** «متأخرة يومين»، «بعد 5 أيام»، «اليوم»، «غداً». The dual takes its accusative and genitive form. */
export function relativeDays(offset: number): string {
  if (offset < 0) {
    const late = -offset;
    if (late === 1) return 'متأخرة يوماً واحداً';
    if (late === 2) return 'متأخرة يومين';
    return `متأخرة ${fmt.count(late, 'day')}`;
  }
  if (offset === 0) return 'اليوم';
  if (offset === 1) return 'غداً';
  if (offset === 2) return 'بعد يومين';
  return `بعد ${fmt.count(offset, 'day')}`;
}
