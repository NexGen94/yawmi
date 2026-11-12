/// <reference types="vite/client" />
import { useEffect } from 'preact/hooks';

import { combine } from '../../data/combine';
import { useHabitsToday } from '../../habits/useHabitsToday';
import { fmt } from '../../lib/format';
import { StateFrame } from '../../ui/StateFrame';
import { Toast } from '../../ui/Toast';
import { DayCards } from './DayCards';
import { DaySummary, type SummaryInsight } from './DaySummary';
import { DueHabits } from './DueHabits';
import { HomeSkeleton } from './HomeSkeleton';
import { QuickAccess } from './QuickAccess';
import { TodayHero } from './TodayHero';
import { type DayEntries, useDayEntries } from './useDayEntries';
import { useLogNote } from './useLogNote';
import './home.css';

/** Days in a cycle (design section 4, the 56-day grid). */
const CYCLE_DAYS = 56;

/** The two lines under the day summary: the saved evening review once the day is closed, else the
 *  morning insight from `GET /v1/today` (which is not shown after closing). */
function summaryInsight(
  morning: { lines: string[]; question: string | null; source_ids: string[] } | null,
  entries: DayEntries,
): SummaryInsight | null {
  const source = entries.closed
    ? entries.review && { kicker: 'رؤية المساء', insight: entries.review }
    : morning && { kicker: 'رؤية الصباح', insight: morning };
  if (!source || source.insight.lines.length === 0) return null;
  return {
    kicker: source.kicker,
    lines: source.insight.lines,
    question: source.insight.question,
    sourceCount: source.insight.source_ids.length,
  };
}

export default function HomePage() {
  const habits = useHabitsToday();
  const entries = useDayEntries(habits.day);
  const { state, stale } = combine(habits, entries);
  const { done, due, badge, day } = habits;
  const note = useLogNote(habits);

  // The badge on the app icon: build habits still to do today. The push module is loaded on demand,
  // so it stays out of the first load.
  const counted = state === 'ready' || (state === 'offline' && stale);
  useEffect(() => {
    if (!counted) return;
    void import('../../push/subscribe').then((push) => push.setBadge(badge)).catch(() => undefined);
  }, [counted, badge]);

  const plan = habits.today?.plan;
  const insight = summaryInsight(habits.today?.insight ?? null, entries);

  return (
    <>
      <div class="home-head">
        <h1>الرئيسية</h1>
        <p class="home-date">
          <span>{fmt.day(day)}</span> <span>{fmt.hijri(day)}</span>
        </p>
        {plan?.cycle != null && plan.day_in_cycle != null && (
          <p class="home-cycle">{`الدورة ${fmt.num(plan.cycle)} · اليوم ${fmt.num(plan.day_in_cycle)} من ${fmt.num(CYCLE_DAYS)}`}</p>
        )}
      </div>
      <StateFrame
        state={state}
        stale={stale}
        emptyText=""
        onRetry={() => {
          habits.reload();
          entries.reload();
        }}
        skeleton={<HomeSkeleton />}
      >
        <div class="page-cols">
          <div class="home-main">
            <TodayHero done={done} due={due} />
            {/* later: «المتأخر وغير المنجز», the overdue section */}
            <DayCards morning={entries.morning} closed={entries.closed} />
            {habits.items.length > 0 && (
              <DueHabits
                items={habits.items}
                onTick={(code) => void habits.tick(code)}
                onAdd={(code, step) => void habits.add(code, step)}
                onUntick={note.untick}
                onSkip={(code) => void habits.skip(code)}
              />
            )}
          </div>
          <div class="home-side">
            {/* later: «رسالتي» and «رؤيتي», written by the person only */}
            {/* later: the four domain cards */}
            <QuickAccess />
            {/* later: the favourite focus combinations, inside the quick access card */}
            <DaySummary morning={entries.morning} evening={entries.evening} insight={insight} />
          </div>
        </div>
      </StateFrame>
      <Toast message={note.message} action={note.action} onDismiss={note.message ? note.dismiss : undefined} />
    </>
  );
}
