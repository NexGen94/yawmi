import { useMemo } from 'preact/hooks';

import { useGoals } from '../../goals/data';
import { fmt } from '../../lib/format';
import { valueNum } from '../../lib/value';
import { useWeekData, WEEK_START } from '../../review/data';
import { type Criterion, type WeekSummary, weekBounds, weekSummary } from '../../review/week';
import type { Day } from '../../domain/types';
import { useSettings } from '../../settings/data';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { ReviewList } from './ReviewList';
import { WeeklyInsight } from './WeeklyInsight';
import { LinkButton } from '../home/LinkButton';

/** The days of a week, for «من 7». */
const WEEK_DAYS = 7;

/** What each criterion is called on the screen; AC3.4 is the two journals, drawn from the journal. */
const CRITERION_LABELS: Record<Criterion, string> = {
  'AC3.4': 'اليوميات',
  'AC2.7': 'التأمل والتصور',
  'AC7.4': 'الإنجليزية',
};

interface Figure {
  key: string;
  label: string;
  ac: Criterion;
  value: string;
  of: string;
}

/** The four numbers of the week (the mockup's four): the morning and the evening journal against the
 *  days of the week, then the criteria some habit carries. A criterion no habit carries is not drawn. */
function figuresOf(summary: WeekSummary): Figure[] {
  const figures: Figure[] = [
    { key: 'morning', label: 'يومية الصباح', ac: 'AC3.4', value: fmt.num(summary.journal.morning), of: `من ${fmt.num(WEEK_DAYS)}` },
    { key: 'evening', label: 'يومية المساء', ac: 'AC3.4', value: fmt.num(summary.journal.evening), of: `من ${fmt.num(WEEK_DAYS)}` },
  ];
  for (const row of summary.byCriterion) {
    if (row.ac === 'AC3.4') continue;
    figures.push({ key: row.ac, label: CRITERION_LABELS[row.ac], ac: row.ac, value: valueNum(row.done), of: `من ${valueNum(row.target)}` });
  }
  return figures;
}

function Lines({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div class="review-lines">
      <h3 class="review-lines-title">{title}</h3>
      <ul aria-label={title} class="review-lines-list">
        {items.length === 0 ? (
          <li class="review-none">لا شيء</li>
        ) : (
          items.map((item, i) => <li key={`${i}-${item}`}>{item}</li>)
        )}
      </ul>
    </div>
  );
}

function WeekSkeleton() {
  return (
    <div class="review-skeleton">
      <Skeleton blockSize="140px" />
      <Skeleton blockSize="160px" />
      <Skeleton blockSize="180px" />
    </div>
  );
}

/** The week tab (design 4): four numbers, then «تمّ» and «معطَّل» and «التالي», then the paragraph
 *  of the AI with the recurring theme and its days, then the earlier reviews. */
export function WeeklyReview({ today }: { today: Day }) {
  const week = useWeekData(today);
  const goals = useGoals();
  const settings = useSettings();
  const maxLines = settings.data?.ai_lines ?? 2;

  const summary = useMemo(
    () =>
      weekSummary({
        habits: week.habits,
        logs: week.logs,
        journal: week.journal,
        goals: goals.data,
        today,
        weekStart: WEEK_START,
      }),
    [week.habits, week.logs, week.journal, goals.data, today],
  );

  // The milestone lines wait for the plan, so they do not first show empty and then fill.
  const state = week.query.state === 'ready' && goals.state === 'loading' ? 'loading' : week.query.state;
  const { start, end } = weekBounds(today, WEEK_START);
  const figures = figuresOf(summary);
  const stored = week.reviews.find((r) => r.day === start);
  const earlier = week.reviews.filter((r) => r.day !== start);
  const empty = week.habits.length === 0 && week.journal.length === 0;

  return (
    <StateFrame
      state={state}
      stale={week.query.stale}
      empty={empty}
      emptyText="لا عادات ولا يوميات هذا الأسبوع بعد"
      emptyAction={<LinkButton href="/habits/new">عادة جديدة</LinkButton>}
      onRetry={week.query.reload}
      skeleton={<WeekSkeleton />}
    >
      <div class="page-cols">
        <div class="review-main">
          <Card title="هذا الأسبوع">
            <p class="review-range">{`من ${fmt.dayShort(start)} إلى ${fmt.dayShort(end)}`}</p>
            <ul class="review-figures" aria-label="أرقام الأسبوع">
              {figures.map((f) => (
                <li key={f.key} class="review-figure" data-ac={f.ac}>
                  <span class="review-figure-label">{f.label}</span>
                  <span class="review-figure-value">
                    <span class="review-figure-num">{f.value}</span>
                    <span class="review-figure-of">{f.of}</span>
                  </span>
                </li>
              ))}
            </ul>
            {summary.adherence.total > 0 && (
              <p class="review-days">{`أيام العادات اليومية: ${fmt.num(summary.adherence.reached)} من ${fmt.num(summary.adherence.total)}`}</p>
            )}
          </Card>
          <Card>
            <div class="review-lists">
              <Lines title="تمّ" items={summary.done} />
              <Lines title="معطَّل" items={summary.blocked} />
              <Lines title="التالي" items={summary.next} />
            </div>
          </Card>
        </div>
        <div class="review-side">
          <WeeklyInsight today={today} stored={stored} maxLines={maxLines} />
          <ReviewList items={earlier} maxLines={maxLines} />
        </div>
      </div>
    </StateFrame>
  );
}
