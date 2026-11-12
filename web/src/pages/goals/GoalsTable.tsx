import type { ComponentChildren } from 'preact';

import { GOAL_COLUMNS, type GoalTable, labelOf, TABLE_LABELS } from '../../goals/columns';
import { relativeDays } from '../../goals/due';
import { DASH, editedDay, fieldLabel, pctOrDash } from '../../goals/format';
import type { CardFull, GoalOutcome, GoalsOut, MilestoneFull } from '../../goals/types';
import { fmt } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Segmented } from '../../ui/Segmented';
import { ColumnChooser } from './ColumnChooser';

type Row = GoalOutcome | MilestoneFull | CardFull;

const TABLE_OPTIONS = (['outcomes', 'milestones', 'cards'] as const).map((value) => ({ value, label: TABLE_LABELS[value] }));

const hrefOf = (table: GoalTable, row: Row): string =>
  `/goals/${encodeURIComponent(table === 'outcomes' ? (row as GoalOutcome).code : (row as MilestoneFull | CardFull).page_id)}`;

const ofTotal = (done: unknown, total: unknown): ComponentChildren =>
  typeof done === 'number' && typeof total === 'number' ? `${fmt.num(done)} من ${fmt.num(total)}` : DASH;

interface Ctx {
  table: GoalTable;
  row: Row;
  record: Record<string, unknown>;
}

const countOf = (value: unknown): ComponentChildren => (Array.isArray(value) && value.length > 0 ? fmt.num(value.length) : DASH);

/** How each field that is not plain text or a plain number is written. */
const FORMATTERS: Record<string, (value: unknown, ctx: Ctx) => ComponentChildren> = {
  title: (value, { table, row }) => <a href={hrefOf(table, row)}>{plain(value)}</a>,
  code: (value) => <Badge>{plain(value)}</Badge>,
  page_id: (value) => <bdi dir="ltr">{plain(value)}</bdi>,
  done: (value) => (value === true ? 'منجزة' : 'مفتوحة'),
  completion: (value) => pctOrDash(value as number | null),
  habits_adherence_avg: (value) => pctOrDash(value as number | null),
  notion_edited_at: (value) => (typeof value === 'string' ? editedDay(value) : DASH),
  overdue_days: (value) => (typeof value === 'number' && value > 0 ? <Badge tone="signal">{relativeDays(-value)}</Badge> : DASH),
  milestones_done: (value, { record }) => ofTotal(value, record.milestones_total),
  tasks_done: (value, { record }) => ofTotal(value, record.tasks_total),
  outcome_codes: (value) => (Array.isArray(value) && value.length > 0 ? value.map(plain).join('، ') : DASH),
  card_page_ids: countOf,
  habits: countOf,
  kpis: countOf,
  pending: (value) => (Array.isArray(value) && value.length > 0 ? value.map((f) => fieldLabel(plain(f))).join('، ') : DASH),
  next_milestone: (value) => {
    const next = value as { title: string; due_date: string | null } | null | undefined;
    if (next === null || next === undefined) return DASH;
    return next.due_date === null ? next.title : `${next.title} · ${fmt.day(next.due_date)}`;
  },
  indicator: (value) => {
    const indicator = value as { value: number | null; target: number | null; completion: number | null };
    if (indicator.value !== null && indicator.target !== null) return `${fmt.num(indicator.value)} من ${fmt.num(indicator.target)}`;
    return pctOrDash(indicator.completion);
  },
};

/** A value as text: a string as it is, a number in the current digits, anything else a dash. */
function plain(value: unknown): string {
  if (typeof value === 'string') return value === '' ? DASH : value;
  if (typeof value === 'number') return fmt.num(value);
  return DASH;
}

/** The text of one cell. A value that is not there is a dash. Dates are words, through `fmt.day`. */
function cellOf(table: GoalTable, row: Row, key: string): ComponentChildren {
  const record = row as unknown as Record<string, unknown>;
  const value = record[key];
  const format = FORMATTERS[key];
  if (format) return format(value, { table, row, record });
  if (key.endsWith('_date') && typeof value === 'string') return fmt.day(value);
  return plain(value);
}

export interface GoalsTableProps {
  goals: GoalsOut;
  table: GoalTable;
  columns: readonly string[];
  /** A choice of columns can be saved: online, and the stored choice is known. */
  canChoose: boolean;
  onTable(table: GoalTable): void;
  onSaveColumns(keys: string[]): Promise<boolean>;
}

/** The three tables of the plan with the columns the owner chose (design A7), read only. The table sits
 *  in a region that scrolls sideways by itself, so the page never does. */
export function GoalsTable({ goals, table, columns, canChoose, onTable, onSaveColumns }: GoalsTableProps) {
  const rows: Row[] = table === 'outcomes' ? goals.outcomes : table === 'milestones' ? goals.milestones : goals.cards;
  const known = new Set(GOAL_COLUMNS[table].map((c) => c.key));
  const shown = columns.filter((key) => known.has(key));
  const keyOf = (row: Row): string => (table === 'outcomes' ? (row as GoalOutcome).code : (row as MilestoneFull | CardFull).page_id);

  return (
    <div class="goals-table">
      <div class="goals-table-controls">
        <Segmented label="الجدول" options={TABLE_OPTIONS} value={table} onChange={onTable} />
        <ColumnChooser table={table} shown={shown} enabled={canChoose} onSave={onSaveColumns} />
      </div>
      {rows.length === 0 ? (
        <p class="goals-table-none">{`لا صفوف في جدول ${TABLE_LABELS[table]}.`}</p>
      ) : (
        <section class="table-scroll" aria-label={`جدول ${TABLE_LABELS[table]}، قابل للتمرير`}>
          <table class="data-table">
            <caption class="visually-hidden">{`جدول ${TABLE_LABELS[table]}`}</caption>
            <thead>
              <tr>
                {shown.map((key) => (
                  <th key={key} scope="col">
                    {labelOf(table, key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={keyOf(row)}>
                  {shown.map((key) => (
                    <td key={key}>{cellOf(table, row, key)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
