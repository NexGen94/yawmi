// The columns of the three goals tables (design 7.4): every field of the row model can be shown, and
// the defaults are the ones the server stores until the owner chooses (`SettingsOut.goal_columns`).

import type { GoalColumnsIO } from './types';

export type GoalTable = 'outcomes' | 'milestones' | 'cards';
export const TABLES: readonly GoalTable[] = ['outcomes', 'milestones', 'cards'];

export interface ColumnDef {
  key: string;
  label: string;
}

export const GOAL_COLUMNS: Record<GoalTable, ColumnDef[]> = {
  outcomes: [
    { key: 'code', label: 'الرمز' },
    { key: 'title', label: 'العنوان' },
    { key: 'track', label: 'المسار' },
    { key: 'target_date', label: 'الموعد' },
    { key: 'acceptance', label: 'معيار القبول' },
    { key: 'status', label: 'الحالة' },
    { key: 'milestones_total', label: 'عدد المحطات' },
    { key: 'milestones_done', label: 'المحطات المنجزة' },
    { key: 'milestones_due', label: 'المحطات المستحقة' },
    { key: 'completion', label: 'الإنجاز' },
    { key: 'next_milestone', label: 'المحطة التالية' },
    { key: 'habits', label: 'العادات' },
    { key: 'indicator', label: 'المؤشر' },
    { key: 'kpis', label: 'مؤشرات الأداء' },
  ],
  milestones: [
    { key: 'page_id', label: 'المعرّف' },
    { key: 'title', label: 'العنوان' },
    { key: 'outcome_code', label: 'المخرج' },
    { key: 'card_page_ids', label: 'البطاقات' },
    { key: 'cycle_no', label: 'الدورة' },
    { key: 'due_date', label: 'الموعد' },
    { key: 'done', label: 'الإنجاز' },
    { key: 'criterion', label: 'المعيار' },
    { key: 'evidence', label: 'الدليل' },
    { key: 'notion_edited_at', label: 'آخر تعديل في Notion' },
    { key: 'overdue_days', label: 'التأخر' },
    { key: 'pending', label: 'التعديلات المعلّقة' },
  ],
  cards: [
    { key: 'page_id', label: 'المعرّف' },
    { key: 'title', label: 'العنوان' },
    { key: 'status', label: 'الحالة' },
    { key: 'outcome_codes', label: 'المخرجات' },
    { key: 'target_date', label: 'الموعد المستهدف' },
    { key: 'next_step', label: 'الخطوة التالية' },
    { key: 'notion_edited_at', label: 'آخر تعديل في Notion' },
    { key: 'habits', label: 'العادات' },
    { key: 'habits_adherence_avg', label: 'التزام العادات' },
    { key: 'milestones_total', label: 'عدد المحطات' },
    { key: 'milestones_done', label: 'المحطات المنجزة' },
    { key: 'tasks_total', label: 'عدد المهام' },
    { key: 'tasks_done', label: 'المهام المنجزة' },
    { key: 'indicator', label: 'المؤشر' },
    { key: 'pending', label: 'التعديلات المعلّقة' },
  ],
};

export const TABLE_LABELS: Record<GoalTable, string> = { outcomes: 'المخرجات', milestones: 'المحطات', cards: 'البطاقات' };

/** The server's defaults (design 7.4). */
export const DEFAULT_COLUMNS: Record<GoalTable, string[]> = {
  outcomes: ['code', 'title', 'completion', 'next_milestone', 'target_date'],
  milestones: ['title', 'outcome_code', 'due_date', 'done', 'cycle_no'],
  cards: ['title', 'status', 'outcome_codes', 'target_date', 'next_step', 'milestones_done'],
};

/** The columns the settings hold, with the defaults for a table they do not hold. */
export function columnsOf(stored: GoalColumnsIO | undefined): Record<GoalTable, string[]> {
  return {
    outcomes: stored?.outcomes ?? DEFAULT_COLUMNS.outcomes,
    milestones: stored?.milestones ?? DEFAULT_COLUMNS.milestones,
    cards: stored?.cards ?? DEFAULT_COLUMNS.cards,
  };
}

/** The label of a column. */
export function labelOf(table: GoalTable, key: string): string {
  return GOAL_COLUMNS[table].find((c) => c.key === key)?.label ?? key;
}
