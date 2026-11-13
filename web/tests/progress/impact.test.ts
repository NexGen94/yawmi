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
function lateOf(
  day: string,
  habits: HabitOut[],
  logs: HabitLogOut[],
  goals?: ReturnType<typeof plan>,
  dueToday: HabitOut[] = habits,
): LateItem[] {
  const bundle = { day, today: todayOut(dueToday, { day }), habits, logs };
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
    expect(impactSentence(item as LateItem)).toBe('متأخرة يومين عن موعدها الأحد، 8 نوفمبر 2026. O1: أُنجز 2 من 3 محطة حان موعدها.');
  });

  it('a milestone one day late, and a milestone three days late', () => {
    const base = { kind: 'milestone', pageId: 'm', title: 'م', dueDate: '2026-11-09', outcomeCode: 'O1', doneDue: 0, totalDue: 1 } as const;
    expect(impactSentence({ ...base, overdueDays: 1 })).toBe('متأخرة يوماً واحداً عن موعدها الاثنين، 9 نوفمبر 2026. O1: أُنجز 0 من 1 محطة حان موعدها.');
    expect(impactSentence({ ...base, overdueDays: 3 })).toBe('متأخرة 3 أيام عن موعدها الاثنين، 9 نوفمبر 2026. O1: أُنجز 0 من 1 محطة حان موعدها.');
  });

  it('a numeric goal under its pace', () => {
    const item: LateItem = { kind: 'goal_pace', ref: 'O3', title: 'الكتب', current: 2, expected: 3, projected: 8, target: 12 };
    expect(impactSentence(item)).toBe('القيمة 2 والمتوقع اليوم 3. بالوتيرة الحالية يُبلغ 8 من 12 عند الموعد.');
    // an estimate is not written to two decimals, and is never above the target (Task 24)
    expect(impactSentence({ ...item, expected: 0.014, projected: 134.8, target: 2 })).toBe('القيمة 2 والمتوقع اليوم أقل من 1. بالوتيرة الحالية يُبلغ 2 من 2 عند الموعد.');
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

describe('fix round 1', () => {
  it('I-1: a late habit that is not scheduled today is marked, and its sentence does not promise a change today', () => {
    // Sunday to Thursday; Thursday 11-12 was missed; today is Friday 11-13, not a scheduled day
    const work = habit('work', 'أيام العمل', { schedule_kind: 'weekdays', weekday_mask: 0b0011111, start_day: '2026-10-10' });
    const logs = Array.from({ length: 30 }, (_, i) => fromOrdinal(toOrdinal('2026-10-10') + i))
      .filter((day) => day !== '2026-11-12')
      .map((day) => logRow('work', day));
    const [item] = lateOf(FRIDAY, [work], logs, undefined, []);
    expect(item).toMatchObject({ kind: 'habit_daily', code: 'work', notDueToday: true });
    const sentence = impactSentence(item as LateItem);
    expect(sentence).toMatch(/^فاتت أمس\. درجة القوة \d+\.$/);
    expect(sentence).not.toContain('إنجاز اليوم');
  });

  it('I-1: a habit that is due today keeps the full sentence and no mark', () => {
    const daily = habit('daily', 'تمرين', { start_day: '2026-10-10' });
    const [item] = lateOf(TUESDAY, [daily], run('daily', '2026-10-10', ['2026-11-09']));
    expect(item).not.toHaveProperty('notDueToday');
  });

  it('M-7: the day of an older miss is written with fmt.day, in the digits in force', () => {
    const mwf = habit('mwf', 'ثلاثة أيام', { schedule_kind: 'weekdays', weekday_mask: 0b0101010, start_day: '2026-11-01' });
    // Monday, Wednesday and Friday; Monday 11-09 was missed; today is Wednesday 11-11
    const [item] = lateOf('2026-11-11', [mwf], [], undefined, []);
    expect(impactSentence(item as LateItem)).toMatch(/^فاتت يوم الاثنين، 9 نوفمبر 2026\./);
    setDigits('arab');
    expect(impactSentence(item as LateItem)).toContain('٩ نوفمبر ٢٠٢٦');
    expect(impactSentence(item as LateItem)).not.toMatch(/2026-11/);
  });

  it('M-7: the due day of a milestone follows the digits setting too', () => {
    const base = { kind: 'milestone', pageId: 'm', title: 'م', dueDate: '2026-11-08', overdueDays: 2, outcomeCode: 'O1', doneDue: 2, totalDue: 3 } as const;
    setDigits('arab');
    expect(impactSentence(base)).toBe('متأخرة يومين عن موعدها الأحد، ٨ نوفمبر ٢٠٢٦. O1: أُنجز ٢ من ٣ محطة حان موعدها.');
  });

  it('I-3: a strength above zero is never written 0, in the sentence', () => {
    // done once on the first day, never again: the strength is about 0.0011 on 2026-11-13
    const faint = habit('faint', 'خافتة', { start_day: '2026-09-01' });
    const [item] = lateOf(FRIDAY, [faint], [logRow('faint', '2026-09-01')]);
    expect(item).toMatchObject({ kind: 'habit_daily' });
    const now = (item as { strengthNow: number }).strengthNow;
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(0.005);
    const sentence = impactSentence(item as LateItem);
    // the same number the ring draws (1%), not 0
    expect(sentence).toContain('درجة القوة 1:');
    expect(sentence).toMatch(/وفواته 1\.$/);
    expect(sentence).not.toMatch(/\s0[:،.]/);
  });
});

describe('goal_pace follows the basis rule of the server (Task 13)', () => {
  // The KPIs of raqib/memory-seed.json that matter: O5, O10 and O12 have a cumulative one; the others
  // have KPIs with targets that the server does not pace on.
  const kpi = (code: string, target: number | null, over: Record<string, unknown> = {}) => ({
    code,
    name: code,
    unit: 'x',
    direction: 'up',
    frequency: 'weekly',
    target,
    latest: null as { day: string; value: number } | null,
    ...over,
  });
  const behind = (code: string, kpis: ReturnType<typeof kpi>[]) =>
    outcome(code, { milestones_total: 2, milestones_done: 0, kpis, target_date: '2031-12-31' });
  const goalsOf = (...outcomes: ReturnType<typeof behind>[]) => plan({ outcomes, milestones: [] });

  it('an outcome whose KPIs are not cumulative is paced on its milestones, as the server does', () => {
    const outcomes = [
      behind('O1', [kpi('weight_kg', null, { direction: 'band' }), kpi('steps_avg', 8000), kpi('strength_sessions', 2)]),
      behind('O2', [kpi('sleep_7h_nights', 5), kpi('who5_raw', 13, { frequency: 'monthly' })]),
      behind('O3', [kpi('reply_rate_pct', 80)]),
      behind('O7', [kpi('english_minutes', 285)]),
      behind('O8', [kpi('consumer_debt_sar', 0, { direction: 'down' }), kpi('emergency_months', 6, { frequency: 'monthly' })]),
      behind('O9', [kpi('side_income_sar', 6000, { frequency: 'monthly' })]),
      behind('O11', [kpi('social_initiations', 2)]),
    ];
    const items = lateOf(TUESDAY, [], [], goalsOf(...outcomes));
    expect(items.map((i) => (i as { ref: string }).ref)).toEqual(['O1', 'O2', 'O3', 'O7', 'O8', 'O9', 'O11']);
    expect(items.every((i) => i.kind === 'goal_pace')).toBe(true);
  });

  it('an outcome with a cumulative KPI is paced on it: behind when the reading is under the line', () => {
    // O5: 5 projects by 2031-12-31 from 2026-10-31; on 2026-11-10 the line is 5 * 10 / 1887 = 0.0265
    const items = lateOf(
      TUESDAY,
      [],
      [],
      goalsOf(behind('O5', [kpi('measured_projects', 5, { frequency: 'cycle', latest: { day: '2026-11-05', value: 0 } })])),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'goal_pace', ref: 'O5', current: 0, target: 5 });
  });

  it('on a cumulative KPI, a reading on the line is on pace, and no reading is not judged', () => {
    const reached = behind('O5', [kpi('measured_projects', 5, { latest: { day: '2026-11-05', value: 1 } })]);
    expect(lateOf(TUESDAY, [], [], goalsOf(reached))).toEqual([]);
    const none = behind('O12', [kpi('workshops_count', 20)]);
    expect(lateOf(TUESDAY, [], [], goalsOf(none))).toEqual([]);
  });

  it('the books of the year run on the calendar year: from the plan start in 2026 to 31 December', () => {
    // 12 books by 2026-12-31 from 2026-10-31: on 2026-11-10 the line is 12 * 10 / 61 = 1.97; 0 read is behind
    const items = lateOf(
      TUESDAY,
      [],
      [],
      goalsOf(behind('O10', [kpi('books_done', 12, { frequency: 'monthly', latest: { day: '2026-11-02', value: 0 } })])),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ref: 'O10', current: 0, target: 12 });
    expect((items[0] as { expected: number }).expected).toBeCloseTo(1.967, 2);
  });

  it('the cumulative KPI with the lowest code is the basis; a reading older than the line is not a reading', () => {
    const o = behind('O5', [
      kpi('workshops_count', 20, { latest: { day: '2026-11-05', value: 0 } }),
      kpi('measured_projects', 5, { latest: { day: '2026-11-05', value: 3 } }),
    ]);
    // measured_projects sorts first and is far ahead of the line
    expect(lateOf(TUESDAY, [], [], goalsOf(o))).toEqual([]);
    const old = behind('O5', [kpi('measured_projects', 5, { latest: { day: '2026-10-01', value: 0 } })]);
    expect(lateOf(TUESDAY, [], [], goalsOf(old))).toEqual([]);
  });
});
