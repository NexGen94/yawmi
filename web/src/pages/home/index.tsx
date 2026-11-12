/// <reference types="vite/client" />
import { useEffect, useState } from 'preact/hooks';

import type { QueryState } from '../../data/query';
import { useHabitsToday } from '../../habits/useHabitsToday';
import { fmt } from '../../lib/format';
import { setBadge } from '../../push/subscribe';
import { StateFrame } from '../../ui/StateFrame';
import { Toast } from '../../ui/Toast';
import { DayCards } from './DayCards';
import { DaySummary, type SummaryInsight } from './DaySummary';
import { DueHabits } from './DueHabits';
import { HomeSkeleton } from './HomeSkeleton';
import { QuickAccess } from './QuickAccess';
import { TodayHero } from './TodayHero';
import { type DayEntries, useDayEntries } from './useDayEntries';
import './home.css';

/** Days in a cycle (design section 4, the 56-day grid). */
const CYCLE_DAYS = 56;
/** How long the «تراجع» note stays. The outbox sends after about five seconds; after that the
 *  note would only say it was sent. */
const NOTE_MS = 8000;
const SENT_NOTE = 'أُرسل التسجيل؛ التصحيح بتخطي اليوم';

interface Loaded {
  state: QueryState;
  stale: boolean;
}

/** Two queries make one page state: an error shows first, then loading, then no connection (with a
 *  saved copy only if every one that is offline has one), else ready. */
function combine(a: Loaded, b: Loaded): Loaded {
  const both = [a, b];
  if (both.some((q) => q.state === 'error')) return { state: 'error', stale: false };
  if (both.some((q) => q.state === 'loading')) return { state: 'loading', stale: false };
  const offline = both.filter((q) => q.state === 'offline');
  if (offline.length > 0) return { state: 'offline', stale: offline.every((q) => q.stale) };
  return { state: 'ready', stale: false };
}

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

const LOGGED_PREFIX = { done: 'سُجّل', skip: 'سُجّل تخطّي اليوم', vacation: 'سُجّلت إجازة اليوم' } as const;

export default function HomePage() {
  const habits = useHabitsToday();
  const entries = useDayEntries(habits.day);
  const { state, stale } = combine(habits, entries);
  const { done, due, last, clearLast, undo, day } = habits;

  // The note after a tap: «تراجع» while the event is unsent, the truth («أُرسل التسجيل…») after.
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setNotice('');
  }, [last?.eventId]);
  useEffect(() => {
    if (!last && !notice) return;
    const timer = setTimeout(() => {
      clearLast();
      setNotice('');
    }, NOTE_MS);
    return () => clearTimeout(timer);
  }, [last?.eventId, notice, clearLast]);

  // The badge on the app icon: habits still to do today.
  const counted = state === 'ready' || (state === 'offline' && stale);
  useEffect(() => {
    if (counted) void setBadge(Math.max(0, due - done));
  }, [counted, due, done]);

  const takeBack = (eventId: string) => {
    void undo(eventId).then((taken) => {
      if (!taken) setNotice(SENT_NOTE);
    });
  };
  const toast = notice
    ? { message: notice, action: undefined }
    : {
        message: last ? `${LOGGED_PREFIX[last.status]}: ${last.title}` : '',
        action: last ? { label: 'تراجع', onAction: () => takeBack(last.eventId) } : undefined,
      };
  const dismissToast = () => {
    clearLast();
    setNotice('');
  };

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
                onValue={(code, value) => void habits.setValue(code, value)}
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
      <Toast message={toast.message} action={toast.action} onDismiss={toast.message ? dismissToast : undefined} />
    </>
  );
}
