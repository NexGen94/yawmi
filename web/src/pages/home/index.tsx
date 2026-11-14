/// <reference types="vite/client" />
import { useEffect, useMemo } from 'preact/hooks';

import { acceptInsight, type GroundedInsight } from '../../ai/guard';
import { combine } from '../../data/combine';
import { useFocusPlans, useFocusSessions, useStoredSession } from '../../focus/data';
import { focusTarget, minutesOn } from '../../focus/today';
import { useGoals } from '../../goals/data';
import { useHabitsToday } from '../../habits/useHabitsToday';
import { fmt } from '../../lib/format';
import { lateItems } from '../../progress/impact';
import { useSettings } from '../../settings/data';
import { Skeleton } from '../../ui/Skeleton';
import { StateFrame } from '../../ui/StateFrame';
import { Toast } from '../../ui/Toast';
import { DomainCards } from '../../goals/DomainCards';
import { cycleWords } from '../../goals/horizons';
import { DayCards } from './DayCards';
import { DaySummary, type SummaryInsight } from './DaySummary';
import { DueHabits } from './DueHabits';
import { HomeSkeleton } from './HomeSkeleton';
import { LateSection } from './LateSection';
import { MissionCard } from './MissionCard';
import { QuickAccess } from './QuickAccess';
import { TodayHero } from './TodayHero';
import { type DayEntries, useDayEntries } from './useDayEntries';
import { useLogNote } from './useLogNote';
import './home.css';

/** The firm rule of the plan: the week starts on Sunday (design 13). */
const WEEK_START = 'sun';

/** The two lines under the day summary, by `ai_checkin` (design 4.1): with `morning` the morning
 *  insight of `GET /v1/today` shows until the day is closed, and not after; with `evening` the saved
 *  evening review shows once the day is closed, and not before. Both are stored rows, so a row older
 *  than task 18 (no cards) still shows its words. One that breaks a limit is not shown. */
function summaryInsight(
  morning: GroundedInsight | null,
  entries: DayEntries,
  checkin: 'morning' | 'evening',
  maxLines: 1 | 2,
): SummaryInsight | null {
  const source =
    checkin === 'evening'
      ? entries.closed && entries.review ? { kicker: 'رؤية المساء', insight: entries.review } : null
      : !entries.closed && morning ? { kicker: 'رؤية الصباح', insight: morning } : null;
  if (!source) return null;
  const accepted = acceptInsight(source.insight, maxLines, { cardsOptional: true });
  if (accepted === null || accepted.lines.length === 0) return null;
  return {
    kicker: source.kicker,
    lines: accepted.lines,
    question: accepted.question,
    sourceCount: accepted.source_ids.length,
    cards: accepted.cards ?? [],
    days: accepted.days ?? [],
  };
}

export default function HomePage() {
  const habits = useHabitsToday();
  const entries = useDayEntries(habits.day);
  const { state, stale } = combine(habits, entries);
  const { done, due, badge, day } = habits;
  const note = useLogNote(habits);
  // The plan and the settings come beside the day, not into its state: a page that cannot read them
  // still shows the habits, and says what is missing in the cards that need them.
  const goals = useGoals();
  const settings = useSettings();
  const focusPlans = useFocusPlans();
  const focusSessions = useFocusSessions(day);
  const storedSession = useStoredSession();
  const lateList = useMemo(
    () =>
      lateItems({ habits: habits.allItems, logs: habits.logs, goals: goals.data, today: day, weekStart: WEEK_START }),
    [habits.allItems, habits.logs, goals.data, day],
  );

  let planState: 'loading' | 'ready' | 'unavailable' = 'ready';
  if (goals.data === undefined) planState = goals.state === 'loading' ? 'loading' : 'unavailable';
  let missionUnavailable: 'offline' | 'error' | undefined;
  if (settings.data === undefined && settings.query.state !== 'loading') {
    missionUnavailable = settings.query.state === 'offline' ? 'offline' : 'error';
  }

  // The badge on the app icon: build habits still to do today. The push module is loaded on demand,
  // so it stays out of the first load.
  const counted = state === 'ready' || (state === 'offline' && stale);
  useEffect(() => {
    if (!counted) return;
    void import('../../push/subscribe').then((push) => push.setBadge(badge)).catch(() => undefined);
  }, [counted, badge]);

  // The focus minutes of today with the sessions still in the outbox, against the minutes the morning
  // planned, else the daily setting. Read beside the day: a page that cannot read them shows no line.
  const planned = (entries.morning?.answers as { planned_minutes?: unknown } | undefined)?.planned_minutes;
  const focus =
    focusSessions.query.data === undefined
      ? undefined
      : {
          minutes: minutesOn(focusSessions.sessions, day),
          target: focusTarget(typeof planned === 'number' ? planned : null, settings.data?.focus_daily_target_min),
        };

  const plan = habits.today?.plan;
  const insight = summaryInsight(
    habits.today?.insight ?? null,
    entries,
    settings.data?.ai_checkin ?? 'evening',
    settings.data?.ai_lines ?? 2,
  );

  return (
    <>
      <div class="home-head">
        <h1>الرئيسية</h1>
        <p class="home-date">
          <span>{fmt.day(day)}</span> <span>{fmt.hijri(day)}</span>
        </p>
        {plan?.cycle != null && plan.day_in_cycle != null && (
          <p class="home-cycle">{cycleWords(plan.cycle, plan.day_in_cycle, day, goals.data)}</p>
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
            <LateSection items={lateList} plan={planState} onTick={(code) => void habits.tick(code)} />
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
            <MissionCard
              mission={settings.data?.mission ?? ''}
              vision={settings.data?.vision ?? ''}
              loading={settings.data === undefined && settings.query.state === 'loading'}
              unavailable={missionUnavailable}
            />
            <section class="home-domains" aria-labelledby="home-domains-title">
              <h2 id="home-domains-title" class="home-domains-title">
                المجالات
              </h2>
              {goals.state === 'loading' && goals.data === undefined ? (
                <Skeleton blockSize="180px" />
              ) : (
                <DomainCards outcomes={goals.data?.outcomes ?? []} />
              )}
            </section>
            <QuickAccess favorites={(focusPlans.data ?? []).filter((p) => p.favorite && p.active)} session={storedSession} />
            <DaySummary morning={entries.morning} evening={entries.evening} insight={insight} focus={focus} />
          </div>
        </div>
      </StateFrame>
      <Toast message={note.message} action={note.action} onDismiss={note.message ? note.dismiss : undefined} />
    </>
  );
}
