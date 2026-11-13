import { useMemo } from 'preact/hooks';

import { YearGrid } from '../../charts/YearGrid';
import type { Day } from '../../domain/types';
import { fmt } from '../../lib/format';
import { valueNum } from '../../lib/value';
import { useMoodData } from '../../review/data';
import { moodByActivity, yearDays, yearLabel } from '../../review/mood-stats';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { LinkButton } from '../home/LinkButton';

function MoodSkeleton() {
  return (
    <div class="review-skeleton">
      <Skeleton blockSize="150px" />
      <Skeleton blockSize="120px" />
    </div>
  );
}

/** The mood tab (feature 19): the year as a grid of shaded days with its key, and the mood on the
 *  days of each habit against the other days. The figures describe what happened and say nothing of
 *  causes; each line carries «للوعي الذاتي». With fewer than five days on a side there is no line. */
export function MoodTab({ today }: { today: Day }) {
  const data = useMoodData(today);
  const year = Number(today.slice(0, 4));
  const days = useMemo(() => yearDays(data.mood, year), [data.mood, year]);
  const rows = useMemo(() => moodByActivity(data.mood, data.logs, data.habits), [data.mood, data.logs, data.habits]);

  return (
    <StateFrame
      state={data.query.state}
      stale={data.query.stale}
      empty={data.mood.length === 0}
      emptyText="لا مزاج مسجَّل بعد"
      emptyAction={<LinkButton href="/day/evening">إغلاق اليوم</LinkButton>}
      onRetry={data.query.reload}
      skeleton={<MoodSkeleton />}
    >
      <div class="review-mood">
        <Card title={`شبكة ${fmt.num(year, { useGrouping: false })}`}>
          <YearGrid year={year} days={days} label={yearLabel(year, days)} />
        </Card>
        <Card title="ترابط الأنشطة بالمزاج">
          <p class="review-note">متوسط المزاج في أيام إنجاز العادة وفي بقية الأيام: وصف لما سُجّل، لا تفسير لأسبابه.</p>
          {rows.length === 0 ? (
            <p class="review-none">لا بيانات كافية</p>
          ) : (
            <ul class="review-correlations" aria-label="المزاج بحسب العادات">
              {rows.map((row) => (
                <li key={row.code}>
                  {`${row.title}: ${valueNum(row.withAvg)} في أيامه، و${valueNum(row.withoutAvg)} في غيرها · للوعي الذاتي`}
                </li>
              ))}
            </ul>
          )}
          <p class="review-note">يظهر السطر حين يكون في كل جهة خمسة أيام فأكثر.</p>
        </Card>
      </div>
    </StateFrame>
  );
}
