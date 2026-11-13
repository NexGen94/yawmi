// The sentences of design 9.2, with their numbers, word for word. The two strength sentences are
// computed from the example logs by `strength` of the domain, not typed in.
import { afterEach, describe, expect, it } from 'vitest';

import { fromOrdinal, toOrdinal } from '../../src/domain/days';
import { buildItems } from '../../src/habits/useHabitsToday';
import { setDigits } from '../../src/lib/format';
import { impactSentence, lateItems, type LateItem } from '../../src/progress/impact';
import { goals as plan, milestone, outcome } from '../helpers/goals-fixtures';
import { habit, type HabitLogOut, type HabitOut, todayOut } from '../helpers/today-fixtures';

afterEach(() => setDigits('latn'));

const TUESDAY = '2026-11-10';
const FRIDAY = '2026-11-13';

const logRow = (code: string, day: string, status: HabitLogOut['status'] = 'done', value: number | null = null): HabitLogOut => ({
  habit_code: code,
  day,
  status,
  value,
});

/** The late items of a day, built the way the home page builds them. */
function lateOf(day: string, habits: HabitOut[], logs: HabitLogOut[], goals?: ReturnType<typeof plan>): LateItem[] {
  const bundle = { day, today: todayOut(habits, { day }), habits, logs };
  const items = buildItems(bundle, [], [], day, 'all');
  return lateItems({ habits: items, logs, goals, today: day, weekStart: 'sun' });
}

/** Thirty consecutive days from `first`. */
const run = (code: string, first: string, skip: string[] = []): HabitLogOut[] =>
  Array.from({ length: 30 }, (_, i) => fromOrdinal(toOrdinal(first) + i))
    .filter((day) => !skip.includes(day))
    .map((day) => logRow(code, day));

const FORBIDDEN = ['يجب', 'عليك', 'للأسف', 'أحسنت'];

describe('impactSentence: the eight sentences of design 9.2', () => {
  it('S3: a weekly duration habit under its pace', () => {
    const english = habit('english', 'الإنجليزية', { kind: 'duration', unit: 'min', period: 'week', target_per_period: 285, start_day: '2026-11-01' });
    const [item] = lateOf(TUESDAY, [english], [logRow('english', '2026-11-08', 'done', 60), logRow('english', TUESDAY, 'done', 25)]);
    expect(item).toMatchObject({ kind: 'habit_period', code: 'english', period: 'week', target: 285, done: 85, daysLeft: 5, possible: true, needPerDay: 40 });
    expect(impactSentence(item as LateItem)).toBe('يلزم 200 دقيقة في 5 أيام لبلوغ هدف الأسبوع (285)، أي 40 دقيقة يومياً.');
  });

  it('a yes/no weekly habit that can no longer reach its target', () => {
    const gym = habit('gym', 'النادي', { period: 'week', target_per_period: 5, start_day: '2026-11-01' });
    const [item] = lateOf(FRIDAY, [gym], [logRow('gym', '2026-11-09')]);
    expect(item).toMatchObject({ kind: 'habit_period', done: 1, daysLeft: 2, possible: false, maxReachable: 3 });
    expect(impactSentence(item as LateItem)).toBe('لم يعد بلوغ هدف الأسبوع ممكناً: الباقي 4 والأيام 2. أقصى ما يُبلغ 3 من 5.');
  });

  it('a count habit under its pace: no «أي… يومياً»', () => {
    const sessions = habit('sessions', 'الجلسات', { kind: 'count', unit: 'session', period: 'week', target_per_period: 5, start_day: '2026-11-01' });
    const [item] = lateOf(FRIDAY, [sessions], [logRow('sessions', '2026-11-09', 'done', 2)]);
    expect(impactSentence(item as LateItem)).toBe('يلزم 3 جلسات في يومين لبلوغ هدف الأسبوع (5).');
  });

  it('a yes/no weekly habit that can still reach its target says «مرتان»', () => {
    const gym = habit('gym', 'النادي', { period: 'week', target_per_period: 5, start_day: '2026-11-01' });
    const logs = ['2026-11-08', '2026-11-09', '2026-11-10'].map((day) => logRow('gym', day));
    const [item] = lateOf(FRIDAY, [gym], logs);
    expect(item).toMatchObject({ done: 3, possible: true });
    expect(impactSentence(item as LateItem)).toBe('يلزم مرتان في يومين لبلوغ هدف الأسبوع (5).');
  });

  it('a daily habit missed yesterday: the strength now, if done, and if missed', () => {
    const daily = habit('daily', 'تمرين', { start_day: '2026-10-10' });
    const [item] = lateOf(TUESDAY, [daily], run('daily', '2026-10-10', ['2026-11-09']));
    expect(item).toMatchObject({ kind: 'habit_daily', code: 'daily' });
    expect(impactSentence(item as LateItem)).toBe('فاتت أمس. درجة القوة 76: إنجاز اليوم يجعلها 77، وفواته 72.');
  });

  it('a milestone past its day', () => {
    const goals = plan({
      outcomes: [outcome('O1', { milestones_total: 3, milestones_done: 2, milestones_due: 3 })],
      milestones: [
        milestone('a', 'أولى', { outcome_code: 'O1', due_date: '2026-11-02', done: true }),
        milestone('b', 'ثانية', { outcome_code: 'O1', due_date: '2026-11-05', done: true }),
        milestone('c', 'متأخرة', { outcome_code: 'O1', due_date: '2026-11-08' }),
      ],
    });
    const [item] = lateOf(TUESDAY, [], [], goals);
    expect(item).toMatchObject({ kind: 'milestone', pageId: 'c', dueDate: '2026-11-08', overdueDays: 2, outcomeCode: 'O1', doneDue: 2, totalDue: 3 });
    expect(impactSentence(item as LateItem)).toBe('متأخرة يومين عن موعدها 2026-11-08. O1: أُنجز 2 من 3 محطة حان موعدها.');
  });

  it('a milestone one day late, and a milestone three days late', () => {
    const base = { kind: 'milestone', pageId: 'm', title: 'م', dueDate: '2026-11-09', outcomeCode: 'O1', doneDue: 0, totalDue: 1 } as const;
    expect(impactSentence({ ...base, overdueDays: 1 })).toBe('متأخرة يوماً واحداً عن موعدها 2026-11-09. O1: أُنجز 0 من 1 محطة حان موعدها.');
    expect(impactSentence({ ...base, overdueDays: 3 })).toBe('متأخرة 3 أيام عن موعدها 2026-11-09. O1: أُنجز 0 من 1 محطة حان موعدها.');
  });

  it('a numeric goal under its pace', () => {
    const item: LateItem = { kind: 'goal_pace', ref: 'O3', title: 'الكتب', current: 2, expected: 3, projected: 8, target: 12 };
    expect(impactSentence(item)).toBe('القيمة 2 والمتوقع اليوم 3. بالوتيرة الحالية يُبلغ 8 من 12 عند الموعد.');
  });

  it('a slip in an abstain habit: the strength now and without it', () => {
    const quit = habit('quit', 'الامتناع', { polarity: 'abstain', start_day: '2026-11-01' });
    const [item] = lateOf(TUESDAY, [quit], [logRow('quit', TUESDAY)]);
    expect(item).toMatchObject({ kind: 'abstain_slip', code: 'quit', when: 'today' });
    expect(impactSentence(item as LateItem)).toBe('انزلاق مسجَّل اليوم. درجة القوة 36، وبدونه 41.');
  });

  it('a slip of yesterday says «أمس»', () => {
    const quit = habit('quit', 'الامتناع', { polarity: 'abstain', start_day: '2026-11-01' });
    const [item] = lateOf(TUESDAY, [quit], [logRow('quit', '2026-11-09')]);
    expect(item).toMatchObject({ kind: 'abstain_slip', when: 'yesterday' });
    expect(impactSentence(item as LateItem)).toMatch(/^انزلاق مسجَّل أمس\. درجة القوة \d+، وبدونه \d+\.$/);
  });

  it('an hour is said in its own dual: «ساعتان»', () => {
    const item: LateItem = {
      kind: 'habit_period',
      code: 'study',
      title: 'المذاكرة',
      habitKind: 'duration',
      unit: 'hour',
      period: 'week',
      target: 10,
      done: 8,
      daysLeft: 2,
      possible: true,
      maxReachable: 10,
      needPerDay: 1,
    };
    expect(impactSentence(item)).toBe('يلزم ساعتان في يومين لبلوغ هدف الأسبوع (10)، أي ساعة يومياً.');
  });

  it('a month, and the digits setting', () => {
    const item: LateItem = {
      kind: 'habit_period',
      code: 'book',
      title: 'القراءة',
      habitKind: 'count',
      unit: '',
      period: 'month',
      target: 12,
      done: 5,
      daysLeft: 12,
      possible: true,
      maxReachable: 12,
      needPerDay: 1,
    };
    expect(impactSentence(item)).toBe('يلزم 7 مرات في 12 يوماً لبلوغ هدف الشهر (12).');
    setDigits('arab');
    expect(impactSentence(item)).toBe('يلزم ٧ مرات في ١٢ يوماً لبلوغ هدف الشهر (١٢).');
  });

  it('no sentence has a word of blame, praise or command', () => {
    const items: LateItem[] = [
      { kind: 'habit_daily', code: 'a', title: 'a', strengthNow: 0.76, strengthIfDone: 0.77, strengthIfMissed: 0.72 },
      { kind: 'abstain_slip', code: 'b', title: 'b', when: 'today', strengthNow: 0.36, strengthWithout: 0.41 },
      { kind: 'milestone', pageId: 'm', title: 'm', dueDate: '2026-11-08', overdueDays: 1, outcomeCode: 'O1', doneDue: 0, totalDue: 1 },
      { kind: 'goal_pace', ref: 'O1', title: 'g', current: 0, expected: 0.004, projected: 0, target: 12 },
    ];
    for (const item of items) for (const word of FORBIDDEN) expect(impactSentence(item)).not.toContain(word);
  });
});

describe('lateItems', () => {
  it('orders the milestones, then the habits, then the goals, oldest milestone first', () => {
    const goals = plan({
      outcomes: [outcome('O1', { milestones_total: 4, milestones_done: 0, milestones_due: 2 })],
      milestones: [
        milestone('new', 'أحدث', { outcome_code: 'O1', due_date: '2026-11-09' }),
        milestone('old', 'أقدم', { outcome_code: 'O1', due_date: '2026-11-05' }),
        milestone('future', 'قادمة', { outcome_code: 'O1', due_date: '2026-11-20' }),
        milestone('closed', 'منجزة', { outcome_code: 'O1', due_date: '2026-11-01', done: true }),
      ],
    });
    const daily = habit('daily', 'تمرين', { start_day: '2026-10-10' });
    const items = lateOf(TUESDAY, [daily], run('daily', '2026-10-10', ['2026-11-09']), goals);
    expect(items.map((i) => i.kind)).toEqual(['milestone', 'milestone', 'habit_daily', 'goal_pace']);
    expect(items.filter((i) => i.kind === 'milestone').map((i) => (i as { pageId: string }).pageId)).toEqual(['old', 'new']);
  });

  it('is empty when nothing is late', () => {
    const daily = habit('daily', 'تمرين', { start_day: '2026-11-09' });
    expect(lateOf(TUESDAY, [daily], [logRow('daily', '2026-11-09')])).toEqual([]);
  });

  it('leaves out an archived habit', () => {
    const archived = habit('old', 'قديمة', { active: false, start_day: '2026-10-10' });
    expect(lateOf(TUESDAY, [archived], [])).toEqual([]);
  });

  it('a habit not scheduled today is still counted when its state is late (as the server counts it)', () => {
    // Monday, Wednesday and Friday habit; Monday (11-09) was missed; today is Tuesday.
    const mwf = habit('mwf', 'ثلاثة أيام', { schedule_kind: 'weekdays', weekday_mask: 0b0101010, start_day: '2026-11-01' });
    const items = lateOf(TUESDAY, [mwf], []);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('habit_daily');
  });
});
