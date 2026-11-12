// The goals of design section 4.1 as API payloads, for Tuesday 2026-11-10: cycle 1 («التأسيس», from
// 2026-10-31 to 2026-12-26, so day 11 of 57), 122 milestones of which 3 are done, 12 outcomes with the
// titles of GOAL-2031.md. Shared by the goals page, the horizons and the timeline tests.

import type { components } from '../../src/api/schema';

type Schemas = components['schemas'];
export type GoalsOut = Schemas['GoalsOut'];
export type GoalOutcome = Schemas['GoalOutcome'];
export type MilestoneFull = Schemas['MilestoneFull'];
export type CardFull = Schemas['CardFull'];
export type CycleOut = Schemas['CycleOut'];

export const TODAY = '2026-11-10';
export const NOON_RIYADH = '2026-11-10T09:00:00Z';

export const OUTCOME_TITLES: Record<string, string> = {
  O1: 'الصحة الجسدية',
  O2: 'الصحة النفسية العالية',
  O3: 'نظام لا يموت',
  O4: 'منصب قيادي براتب عالٍ، وجاهزية VP',
  O5: 'أدلة مهنية مقاسة',
  O6: 'الشهادات والتعليم (بحلول 2031-06-30)',
  O7: 'الإنجليزية (أولوية عالية)',
  O8: 'الأمان المالي',
  O9: 'ثلاثة مصادر دخل',
  O10: 'القيادة والصفات',
  O11: 'الحياة الاجتماعية والأسرة والإيمان',
  O12: 'الأثر والتعليم',
};

const NO_INDICATOR = { source: 'milestones', value: null, target: null, completion: null, display: 'ring', custom: false } as const;

export function milestone(page_id: string, title: string, over: Partial<MilestoneFull> = {}): MilestoneFull {
  return {
    page_id,
    title,
    outcome_code: 'O1',
    card_page_ids: [],
    cycle_no: 1,
    due_date: null,
    done: false,
    criterion: null,
    evidence: null,
    notion_edited_at: null,
    overdue_days: null,
    pending: [],
    ...over,
  };
}

export function outcome(code: string, over: Partial<GoalOutcome> = {}): GoalOutcome {
  return {
    code,
    title: OUTCOME_TITLES[code] ?? code,
    track: 'المسار',
    target_date: '2031-12-31',
    acceptance: `معيار قبول ${code}`,
    status: 'جارٍ',
    milestones_total: 0,
    milestones_done: 0,
    milestones_due: 0,
    completion: null,
    next_milestone: null,
    habits: [],
    indicator: { ...NO_INDICATOR },
    kpis: [],
    ...over,
  };
}

export function card(page_id: string, title: string, over: Partial<CardFull> = {}): CardFull {
  return {
    page_id,
    title,
    status: 'قيد التنفيذ',
    outcome_codes: [],
    target_date: null,
    next_step: null,
    notion_edited_at: null,
    habits: [],
    habits_adherence_avg: null,
    milestones_total: 0,
    milestones_done: 0,
    tasks_total: 0,
    tasks_done: 0,
    indicator: { ...NO_INDICATOR },
    pending: [],
    ...over,
  };
}

const DAY_MS = 86_400_000;
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 21 cycles from the plan start: the first is 57 days (the story's), the others eight weeks. */
export function cycles(): CycleOut[] {
  const first = Date.UTC(2026, 9, 31);
  const out: CycleOut[] = [];
  for (let n = 1; n <= 21; n += 1) {
    const start = n === 1 ? first : first + (57 + (n - 2) * 56) * DAY_MS;
    const end = n === 1 ? first + 56 * DAY_MS : start + 55 * DAY_MS;
    out.push({
      cycle_no: n,
      stage_no: Math.ceil(n / 5),
      start_date: isoOf(start),
      end_date: isoOf(end),
      review_start: isoOf(end - 6 * DAY_MS),
      review_end: isoOf(end),
      theme: n === 1 ? 'التأسيس' : `موضوع الدورة ${n}`,
      gate: '',
    });
  }
  return out;
}

const done = (id: string, title: string, outcome_code: string, due_date: string): MilestoneFull =>
  milestone(id, title, { outcome_code, due_date, done: true });

/** 122 milestones, 3 done. Today is 2026-11-10, a Tuesday (the week runs Sunday 8 to Saturday 14).
 *  Open and near: one two days late, two this week, one in five days, one later this month. The rest
 *  fall from 2027 on. */
export function milestones(): MilestoneFull[] {
  const head: MilestoneFull[] = [
    done('m-done-1', 'تعريف مؤشرات الصحة', 'O1', '2026-11-02'),
    done('m-done-2', 'اختيار مزوّد الدورة', 'O6', '2026-11-04'),
    done('m-done-3', 'جدول المذاكرة الأسبوعي', 'O7', '2026-11-06'),
    milestone('m-late', 'مراجعة الميزانية', { outcome_code: 'O8', due_date: '2026-11-08', overdue_days: 2 }),
    milestone('m-blood', 'فحص الدم السنوي', { outcome_code: 'O1', due_date: '2026-11-12', evidence: 'نتيجة المختبر' }),
    milestone('m-cert', 'تسجيل موعد الاختبار', { outcome_code: 'O6', due_date: '2026-11-13' }),
    milestone('m-five', 'حجز دورة الإنجليزية', { outcome_code: 'O7', due_date: '2026-11-15' }),
    milestone('m-month', 'تحديث السيرة المهنية', { outcome_code: 'O4', due_date: '2026-11-28' }),
  ];
  const rest: MilestoneFull[] = [];
  for (let i = 0; rest.length + head.length < 122; i += 1) {
    rest.push(
      milestone(`m-later-${i}`, `محطة لاحقة ${i + 1}`, {
        outcome_code: `O${1 + (i % 12)}`,
        due_date: `${2027 + Math.floor(i / 24)}-${String(1 + (i % 12)).padStart(2, '0')}-15`,
        cycle_no: 2 + (i % 19),
      }),
    );
  }
  return [...head, ...rest];
}

export function cards(): CardFull[] {
  return [
    card('c-health', 'خطة اللياقة', {
      outcome_codes: ['O1'],
      target_date: '2026-12-31',
      next_step: 'حجز موعد الفحص',
      milestones_total: 4,
      milestones_done: 1,
    }),
    card('c-english', 'مسار الإنجليزية', { outcome_codes: ['O7'] }),
  ];
}

export function goals(over: Partial<GoalsOut> = {}): GoalsOut {
  const ms = milestones();
  const outcomes = Object.keys(OUTCOME_TITLES).map((code) => {
    const mine = ms.filter((m) => m.outcome_code === code);
    const finished = mine.filter((m) => m.done).length;
    return outcome(code, {
      milestones_total: mine.length,
      milestones_done: finished,
      completion: mine.length === 0 ? null : finished / mine.length,
    });
  });
  return {
    outcomes,
    cycles: cycles(),
    milestones: ms,
    cards: cards(),
    synced_at: '2026-11-10T05:00:00Z',
    pending_edits: 0,
    ...over,
  };
}

export const EMPTY_GOALS: GoalsOut = { outcomes: [], cycles: [], milestones: [], cards: [], synced_at: null, pending_edits: 0 };
