import type { ComponentChildren } from 'preact';

import { api } from '../../api/client';
import type { components } from '../../api/schema';
import { HttpError, unwrap } from '../../api/unwrap';
import { Heatmap } from '../../charts/Heatmap';
import { Ring } from '../../charts/Ring';
import { WeekBars } from '../../charts/WeekBars';
import { combine } from '../../data/combine';
import { toDomainLogs } from '../../data/pending';
import { useQuery } from '../../data/query';
import { fromOrdinal, toOrdinal } from '../../domain/days';
import { useGoals, useOnline } from '../../goals/data';
import { cycleLengthOf } from '../../goals/horizons';
import { amount, lateWord, PERIOD_WORD } from '../../habits/amount';
import { abstainNote } from '../../habits/HabitRow';
import { type HabitTodayItem, useHabitsToday } from '../../habits/useHabitsToday';
import { IndicatorPanel } from '../../indicators/IndicatorPanel';
import { useIndicators } from '../../indicators/data';
import { fmt } from '../../lib/format';
import { habitIndicator } from '../../progress/indicator';
import type { HabitState } from '../../progress/state';
import { LinkButton } from '../home/LinkButton';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { Toast } from '../../ui/Toast';
import { useLogNote } from '../home/useLogNote';
import { dayStates, gridStart, periodMarks } from './dayStates';
import { PeriodMarks } from './PeriodMarks';
import { VotesCount } from './VotesCount';
import './habits.css';

type ProgressOut = components['schemas']['ProgressOut'];

const ANCHOR = { after_wake: 'بعد الاستيقاظ', free: 'خلال اليوم', before_sleep: 'قبل النوم' } as const;
// Bit 0 is Sunday, bit 6 is Saturday (the reminders' days_mask).
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;
const ALL_DAYS = 0b1111111;
/** The firm rule of the plan: the week starts on Sunday (design 13). */
const WEEK_START = 'sun';

/** What a state is called on the page (design 9.1); an active habit needs no word. */
function stateBadge(item: HabitTodayItem): { text: ComponentChildren; signal: boolean } | undefined {
  const words: Record<HabitState, ComponentChildren | undefined> = {
    archived: 'مؤرشفة',
    upcoming: `تبدأ في ${fmt.day(item.habit.start_day)}`,
    ended: 'انتهت مدتها',
    done: 'تحقق هدف الفترة',
    late: lateWord(item.habit.period),
    active: undefined,
  };
  const text = words[item.state];
  return text === undefined ? undefined : { text, signal: item.state === 'late' };
}

/** What to know about the grid, said once under it. */
function gridNoteOf(habit: HabitTodayItem['habit']): string | undefined {
  if (habit.polarity === 'abstain') return undefined;
  if (habit.period === 'day') return 'اليوم يظهر «لا تسجيل» حتى يُسجَّل.';
  return `العادة ${habit.period === 'week' ? 'الأسبوعية' : 'الشهرية'} يُحكم عليها بفترتها كلها لا بأيامها، فاليوم بلا تسجيل ليس تفويتاً.`;
}

function reminderDays(mask: number): string {
  if (mask === ALL_DAYS) return 'كل يوم';
  return WEEKDAYS.filter((_, bit) => (mask >> bit) & 1).join('، ');
}

/** A count of periods: «3 أيام»، «أسبوعان»، «5 أشهر». */
function periods(n: number, period: 'day' | 'week' | 'month'): string {
  if (period === 'day') return fmt.stat(n, 'day');
  const forms = period === 'week' ? ['أسبوع', 'أسبوعان', 'أسابيع', 'أسبوعاً'] : ['شهر', 'شهران', 'أشهر', 'شهراً'];
  if (n === 1) return `${fmt.num(1)} ${forms[0] ?? ''}`;
  if (n === 2) return `${fmt.num(2)} ${forms[2] ?? ''}`;
  const last2 = Number.isInteger(n) ? n % 100 : -1;
  return `${fmt.num(n)} ${last2 >= 3 && last2 <= 10 ? forms[2] : forms[3]}`;
}

function DetailSkeleton() {
  return (
    <div class="page-cols">
      <div class="detail-col">
        <div class="card">
          <Skeleton blockSize="var(--fs-section)" inlineSize="30%" />
          <Skeleton round blockSize="120px" inlineSize="120px" />
        </div>
        <div class="card">
          <Skeleton blockSize="var(--fs-section)" inlineSize="40%" />
          <Skeleton blockSize="120px" />
        </div>
        <div class="card">
          <Skeleton blockSize="var(--fs-section)" inlineSize="40%" />
          <Skeleton blockSize="200px" />
        </div>
      </div>
      <div class="detail-col">
        <div class="card">
          <Skeleton blockSize="var(--fs-section)" inlineSize="40%" />
          <Skeleton />
          <Skeleton inlineSize="70%" />
        </div>
        <div class="card">
          <Skeleton blockSize="var(--fs-section)" inlineSize="40%" />
          <Skeleton />
          <Skeleton inlineSize="70%" />
        </div>
      </div>
    </div>
  );
}

export interface HabitDetailProps {
  /** Filled in by the router from `/habits/:code`. */
  params?: { code?: string };
}

export default function HabitDetailPage({ params }: HabitDetailProps) {
  const code = params?.code ?? '';
  const habits = useHabitsToday('all');
  // The server's indicators for a habit: its strength, the last periods, the total. A habit it does
  // not know answers 404, which is «no such habit», not an error.
  const progress = useQuery<ProgressOut | null>(`habit-progress:${code}:${habits.day}`, async () => {
    try {
      return unwrap(await api.GET('/v1/habits/{code}/progress', { params: { path: { code } } }));
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  });
  const note = useLogNote(habits);
  const stored = useIndicators();
  const online = useOnline();
  const goals = useGoals();
  const { state, stale } = combine(habits, progress);

  const item = habits.items.find((i) => i.habit.code === code);
  const indicators = progress.data ?? undefined;
  const config = stored.get('habit', code);
  // The first day of the current cycle, for a total over the cycle.
  const dayInCycle = habits.today?.plan.day_in_cycle;
  const cycleStart = dayInCycle == null ? null : fromOrdinal(toOrdinal(habits.day) - (dayInCycle - 1));
  const missing = state === 'ready' && (item === undefined || indicators === undefined);
  const habit = item?.habit;
  const badge = item && stateBadge(item);
  // The grid is the whole cycle, as long as the mirror says it is (57 days for the first): the same
  // number the home and goals pages give. Without the mirror it is the 56 days of the default.
  const plan = habits.today?.plan;
  const cycleLength = goals.data === undefined || plan?.cycle == null ? undefined : cycleLengthOf(goals.data, plan.cycle);
  const grid = gridStart(habits.day, plan?.day_in_cycle, cycleLength);
  const gridNote = habit && gridNoteOf(habit);
  // Not on a day the habit is not scheduled, as on the list.
  const live = item !== undefined && item.dueToday && item.state !== 'archived' && item.state !== 'ended' && item.state !== 'upcoming';

  return (
    <>
      <div class="habits-head">
        <h1>{habit?.title_ar ?? 'تفاصيل العادة'}</h1>
        {habit && (
          <a class="btn btn-primary" href={`/habits/${encodeURIComponent(habit.code)}/edit`}>
            تعديل
          </a>
        )}
      </div>
      <StateFrame
        state={state}
        stale={stale}
        empty={missing}
        emptyText="لا توجد عادة بهذا الرمز."
        emptyAction={
          <a class="btn btn-quiet" href="/habits">
            العادات
          </a>
        }
        onRetry={() => {
          habits.reload();
          progress.reload();
        }}
        skeleton={<DetailSkeleton />}
      >
        {habit && item && indicators && (
          <>
            <div class="detail-meta">
              {habit.identity_text && <p class="detail-identity">{habit.identity_text}</p>}
              <p class="detail-badges">
                {habit.outcome && <Badge>{habit.outcome}</Badge>}
                {badge && <Badge tone={badge.signal ? 'signal' : 'neutral'}>{badge.text}</Badge>}
              </p>
            </div>
            <div class="page-cols">
              <div class="detail-col">
                <IndicatorPanel
                  subject={{ kind: 'habit', ref: habit.code, title: habit.title_ar }}
                  view={habitIndicator(
                    habit,
                    toDomainLogs(habits.logs, habit.code),
                    config,
                    habits.day,
                    WEEK_START,
                    indicators.strength,
                    cycleStart,
                  )}
                  display={config?.display ?? 'ring'}
                  online={online}
                  habit={habit}
                  config={config}
                  onChanged={() => {
                    habits.reload();
                    stored.query.reload();
                  }}
                />
                <Card title="درجة القوة" class="strength-card">
                  <div class="strength-body">
                    <Ring value={indicators.strength} label="درجة القوة" size={120} />
                    <p class="strength-note">لا تُصفَّر: يوم فائت يخفضها قليلاً ولا يمحو ما بُني.</p>
                  </div>
                </Card>
                <Card title="آخر 8 فترات">
                  <WeekBars
                    label="نسبة إنجاز آخر 8 فترات"
                    values={indicators.last_8_periods.map((v) => Math.round(v * 100))}
                    slots={8}
                  />
                  <p class="bars-axis" aria-hidden="true">
                    <span>الأقدم</span>
                    <span>الأحدث</span>
                  </p>
                </Card>
                <Card title={grid.cycle ? 'أيام الدورة' : 'آخر 56 يوماً'}>
                  <Heatmap label={grid.cycle ? 'أيام الدورة' : 'آخر 56 يوماً'} days={dayStates(habit, habits.logs, grid.first, habits.day, grid.days)} />
                  {habit.period !== 'day' && (
                    <PeriodMarks period={habit.period} marks={periodMarks(habit, habits.logs, grid.first, habits.day)} />
                  )}
                  {gridNote && <p class="detail-note">{gridNote}</p>}
                </Card>
              </div>
              <div class="detail-col">
                <VotesCount habit={habit} total={indicators.total_done} />
                <Card title="التقدّم">
                  <dl class="facts">
                    <div>
                      <dt>{habit.polarity === 'abstain' ? 'اليوم' : 'الفترة الحالية'}</dt>
                      <dd>
                        {habit.polarity === 'abstain'
                          ? abstainNote(item, { dated: false })
                          : `${fmt.num(item.progress.done)} من ${amount(item.progress.target, habit.kind === 'boolean' ? '' : habit.unit)} ${PERIOD_WORD[habit.period]}`}
                      </dd>
                    </div>
                    <div>
                      <dt>السلسلة الحالية</dt>
                      <dd>{periods(indicators.streak, habit.period)}</dd>
                    </div>
                    {indicators.adherence !== null && (
                      <div>
                        <dt>الالتزام</dt>
                        <dd>{fmt.pct(indicators.adherence)}</dd>
                      </div>
                    )}
                    {indicators.challenge && (
                      <div>
                        <dt>التحدّي</dt>
                        <dd>
                          {`${fmt.num(indicators.challenge.achieved)} من ${fmt.count(indicators.challenge.total, 'day')} · بقي ${fmt.count(indicators.challenge.remaining_days, 'day')}`}
                        </dd>
                      </div>
                    )}
                  </dl>
                </Card>
                <Card title="المرسى والتذكيرات">
                  <p class="detail-anchor">{ANCHOR[habit.anchor]}</p>
                  {habit.reminders.length === 0 ? (
                    <>
                      <p class="detail-note">لا تذكيرات.</p>
                      <LinkButton href={`/habits/${encodeURIComponent(habit.code)}/edit`}>إضافة تذكير</LinkButton>
                    </>
                  ) : (
                    <ul class="reminders">
                      {habit.reminders.map((r) => (
                        <li key={`${r.time}-${r.days_mask}`}>{`${r.time} · ${reminderDays(r.days_mask)}`}</li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title="اليوم">
                  <div class="detail-actions">
                    <Button disabled={!live} onClick={() => void habits.skip(habit.code)}>
                      تخطي اليوم
                    </Button>
                    <Button disabled={!live} onClick={() => void habits.vacation(habit.code)}>
                      إجازة
                    </Button>
                  </div>
                </Card>
              </div>
            </div>
          </>
        )}
      </StateFrame>
      <Toast message={note.message} action={note.action} onDismiss={note.message ? note.dismiss : undefined} />
    </>
  );
}
