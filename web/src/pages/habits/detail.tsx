import type { ComponentChildren } from 'preact';

import { api } from '../../api/client';
import type { components } from '../../api/schema';
import { HttpError, unwrap } from '../../api/unwrap';
import { Heatmap } from '../../charts/Heatmap';
import { Ring } from '../../charts/Ring';
import { WeekBars } from '../../charts/WeekBars';
import { combine } from '../../data/combine';
import { useQuery } from '../../data/query';
import { amount, PERIOD_WORD } from '../../habits/amount';
import { IsoDay } from '../../habits/IsoDay';
import { type HabitTodayItem, useHabitsToday } from '../../habits/useHabitsToday';
import { fmt } from '../../lib/format';
import type { HabitState } from '../../progress/state';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { Toast } from '../../ui/Toast';
import { useLogNote } from '../home/useLogNote';
import { dayStates } from './dayStates';
import { VotesCount } from './VotesCount';
import './habits.css';

type ProgressOut = components['schemas']['ProgressOut'];

const ANCHOR = { after_wake: 'بعد الاستيقاظ', free: 'خلال اليوم', before_sleep: 'قبل النوم' } as const;
// Bit 0 is Sunday, bit 6 is Saturday (the reminders' days_mask).
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;
const ALL_DAYS = 0b1111111;

/** What a state is called on the page (design 9.1); an active habit needs no word. */
function stateBadge(item: HabitTodayItem): { text: ComponentChildren; signal: boolean } | undefined {
  const words: Record<HabitState, ComponentChildren | undefined> = {
    archived: 'مؤرشفة',
    upcoming: (
      <>
        تبدأ في <IsoDay day={item.habit.start_day} />
      </>
    ),
    ended: 'انتهت مدتها',
    done: 'تحقق هدف الفترة',
    late: 'متأخرة',
    active: undefined,
  };
  const text = words[item.state];
  return text === undefined ? undefined : { text, signal: item.state === 'late' };
}

function reminderDays(mask: number): string {
  if (mask === ALL_DAYS) return 'كل يوم';
  return WEEKDAYS.filter((_, bit) => (mask >> bit) & 1).join('، ');
}

/** A count of periods: «3 أيام»، «أسبوعان»، «5 أشهر». */
function periods(n: number, period: 'day' | 'week' | 'month'): string {
  if (period === 'day') return fmt.count(n, 'day');
  const forms = period === 'week' ? ['أسبوع', 'أسبوعان', 'أسابيع', 'أسبوعاً'] : ['شهر', 'شهران', 'أشهر', 'شهراً'];
  if (n === 1) return forms[0] ?? '';
  if (n === 2) return forms[1] ?? '';
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
  const { state, stale } = combine(habits, progress);

  const item = habits.items.find((i) => i.habit.code === code);
  const indicators = progress.data ?? undefined;
  const missing = state === 'ready' && (item === undefined || indicators === undefined);
  const habit = item?.habit;
  const badge = item && stateBadge(item);
  const live = item !== undefined && item.state !== 'archived' && item.state !== 'ended' && item.state !== 'upcoming';

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
            {/* later: the indicator card, with its «إضافة تذكير» */}
            <div class="page-cols">
              <div class="detail-col">
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
                  />
                </Card>
                <Card title="آخر 56 يوماً">
                  <Heatmap label="آخر 56 يوماً" days={dayStates(habit, habits.logs, habits.day)} />
                  <p class="detail-note">اليوم يُحتسب بعد تسجيله.</p>
                </Card>
              </div>
              <div class="detail-col">
                <VotesCount habit={habit} total={indicators.total_done} />
                <Card title="التقدّم">
                  <dl class="facts">
                    <div>
                      <dt>الفترة الحالية</dt>
                      <dd>
                        {`${fmt.num(item.progress.done)} من ${amount(item.progress.target, habit.kind === 'boolean' ? '' : habit.unit)} ${PERIOD_WORD[habit.period]}`}
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
                    <p class="detail-note">لا تذكيرات.</p>
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
