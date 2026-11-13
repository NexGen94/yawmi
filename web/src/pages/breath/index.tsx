/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { BreathSessionOut } from '../../breath/calc';
import { mergeSessions, useBreathSessions } from '../../breath/data';
import { PATTERNS, type PatternCode, SAFETY_TEXT } from '../../breath/patterns';
import { type Choice, choiceFromPrefs, defaultChoice, prefsOf, sameChoice } from '../../breath/prefs';
import { type Cue, createCue } from '../../breath/sound';
import { type BreathEndedPayload, breathPayload, type Feeling } from '../../breath/timing';
import { endBreath } from '../../data/events';
import type { WeekStart } from '../../domain/types';
import { useOnline, useToday } from '../../goals/data';
import { todayRiyadh } from '../../lib/today';
import { useSettings } from '../../settings/data';
import { useDigits } from '../../settings/digits';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { HeroCard } from '../../ui/HeroCard';
import { StateFrame } from '../../ui/StateFrame';
import { Skeleton } from '../../ui/Skeleton';
import { ExhaleTest } from './ExhaleTest';
import { HoldTest } from './HoldTest';
import { PatternPicker } from './PatternPicker';
import { SessionCheckin } from './SessionCheckin';
import { SessionRun, SessionSheet } from './SessionSheet';
import { WeekRing } from './WeekRing';
import './breath.css';

/** The firm rule of the plan: the week starts on Sunday (design 13). */
const WEEK_START: WeekStart = 'sun';

interface CheckinStage {
  kind: 'checkin';
  pattern: PatternCode;
  rate: number;
  startedMs: number;
  elapsedMs: number;
  plannedSeconds: number;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'running'; startedMs: number; pattern: PatternCode; rate: number; minutes: number; cue: Cue | null }
  | CheckinStage;

function localSession(id: string, payload: BreathEndedPayload, startedMs: number): BreathSessionOut {
  return {
    id,
    day: todayRiyadh(new Date(startedMs)),
    started_at: payload.started_at ?? new Date(startedMs).toISOString(),
    ended_at: payload.ended_at ?? null,
    pattern: payload.pattern,
    breaths_per_min: payload.breaths_per_min ?? null,
    duration_seconds: payload.duration_seconds ?? null,
    completed: payload.completed,
    feeling: payload.feeling ?? null,
  };
}

/** `/breath`: the paced sessions, the weekly ring, the exhale test and the optional hold test. The
 *  safety text is on the page in every state. A session needs no connection: it is timed here and
 *  queued like every record. Only the data of the week (the ring, the means) waits for the server. */
export default function BreathPage() {
  useDigits();
  const today = useToday();
  const online = useOnline();
  const settings = useSettings();
  const sessionsQuery = useBreathSessions(today);
  const [local, setLocal] = useState<BreathSessionOut[]>([]);
  const [choice, setChoice] = useState<Choice>(() => defaultChoice(Date.now()));
  const touched = useRef(false);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [active, setActive] = useState<'exhale' | 'hold' | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const mounted = useRef(true);

  const sessions = useMemo(() => mergeSessions(sessionsQuery.data ?? [], local), [sessionsQuery.data, local]);

  // The saved choices come back in the next session, unless the person has already chosen here.
  const saved = settings.data;
  useEffect(() => {
    if (saved !== undefined && !touched.current) setChoice(choiceFromPrefs(saved.breath_prefs, defaultChoice(Date.now())));
  }, [saved]);

  const change = (patch: Partial<Choice>): void => {
    touched.current = true;
    setChoice((c) => ({ ...c, ...patch }));
  };
  const pickPattern = (pattern: PatternCode): void => change({ pattern, rate: PATTERNS[pattern].rate });

  /** The session is on the screen at once, and also in the list of the week until the server holds it. */
  const remember = useCallback((id: string, payload: BreathEndedPayload, startedMs: number): void => {
    if (mounted.current) setLocal((list) => [...list, localSession(id, payload, startedMs)]);
  }, []);

  const queueTest = (payload: BreathEndedPayload): void => {
    const startedMs = Date.parse(payload.started_at ?? '') || Date.now();
    void endBreath(payload).then((id) => remember(id, payload, startedMs));
  };

  // The session waiting for its question: it is queued when the question is answered or passed over,
  // and, if the page is left first, with no answer. One event, once.
  const waiting = useRef<CheckinStage | null>(null);
  const record = useCallback(
    (session: CheckinStage, feeling: Feeling | null): void => {
      const payload = breathPayload({ ...session, feeling });
      void endBreath(payload).then((id) => remember(id, payload, session.startedMs));
    },
    [remember],
  );
  const settle = useCallback(
    (feeling: Feeling | null): void => {
      const session = waiting.current;
      if (session === null) return;
      waiting.current = null;
      record(session, feeling);
    },
    [record],
  );
  useEffect(() => {
    const leave = (): void => settle(null);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      mounted.current = false;
      settle(null);
    };
  }, [settle]);

  const stageRef = useRef(stage);
  stageRef.current = stage;
  useEffect(
    () => () => {
      const current = stageRef.current;
      if (current.kind === 'running') current.cue?.close();
    },
    [],
  );

  const saveChoice = (): void => {
    if (!touched.current || !online) return;
    const stored = settings.data?.breath_prefs;
    if (stored && sameChoice(choiceFromPrefs(stored, choice), choice)) return;
    void settings.save({ breath_prefs: prefsOf(choice) }).then((ok) => mounted.current && setSaveFailed(!ok));
  };

  const start = (): void => {
    // The sound is made inside this click: the browser allows it only after a gesture.
    let cue: Cue | null = null;
    if (choice.sound) {
      cue = createCue();
      cue.prime();
    }
    setStage({ kind: 'running', startedMs: Date.now(), pattern: choice.pattern, rate: choice.rate, minutes: choice.minutes, cue });
    saveChoice();
  };

  const endRun = (elapsedMs: number): void => {
    const current = stageRef.current;
    if (current.kind !== 'running') return;
    current.cue?.close();
    // Nothing happened in under a second: no session and no question.
    if (elapsedMs < 1000) {
      setStage({ kind: 'idle' });
      return;
    }
    const session: CheckinStage = {
      kind: 'checkin',
      pattern: current.pattern,
      rate: current.rate,
      startedMs: current.startedMs,
      elapsedMs,
      plannedSeconds: current.minutes * 60,
    };
    waiting.current = session;
    setStage(session);
  };

  const answer = (feeling: Feeling | null): void => {
    settle(feeling);
    setStage({ kind: 'idle' });
  };

  // The focus follows the stage: the heading of the session, then of the question, then the start.
  const previous = useRef<Stage['kind']>('idle');
  useEffect(() => {
    const before = previous.current;
    previous.current = stage.kind;
    if (before === stage.kind) return;
    if (stage.kind === 'idle') startRef.current?.focus();
    else headingRef.current?.focus();
  }, [stage.kind]);

  const target = settings.data?.breath_weekly_target_min ?? null;
  const busy = stage.kind !== 'idle' || active !== null;
  const testProps = (kind: 'exhale' | 'hold') => ({
    sessions,
    disabled: stage.kind !== 'idle' || (active !== null && active !== kind),
    onActive: (on: boolean) => setActive(on ? kind : null),
    onDone: queueTest,
  });

  return (
    <div class="breath-page">
      <h1>التنفّس</h1>
      <Card class="breath-safety">
        <p>{SAFETY_TEXT}</p>
      </Card>
      <div class="page-cols">
        <div class="breath-main">
          <HeroCard class="breath-hero">
            <div class="breath-stage" data-stage={stage.kind}>
              {stage.kind === 'idle' && (
                <>
                  <h2 class="card-title" tabIndex={-1} ref={headingRef}>
                    جلسة تنفّس
                  </h2>
                  <PatternPicker pattern={choice.pattern} rate={choice.rate} onChange={pickPattern} />
                  <SessionSheet
                    choice={choice}
                    onChange={change}
                    disabled={busy}
                    online={online}
                    saveFailed={saveFailed}
                    onStart={start}
                    startRef={startRef}
                  />
                </>
              )}
              {stage.kind === 'running' && (
                <>
                  <h2 class="card-title" tabIndex={-1} ref={headingRef}>
                    {`جلسة جارية · ${PATTERNS[stage.pattern].label}`}
                  </h2>
                  <SessionRun
                    pattern={stage.pattern}
                    rate={stage.rate}
                    minutes={stage.minutes}
                    startedMs={stage.startedMs}
                    cue={stage.cue}
                    onEnd={endRun}
                  />
                </>
              )}
              {stage.kind === 'checkin' && (
                <>
                  <h2 class="card-title" tabIndex={-1} ref={headingRef}>
                    بعد الجلسة
                  </h2>
                  <SessionCheckin onChoose={answer} />
                </>
              )}
            </div>
          </HeroCard>
        </div>
        <div class="breath-side">
          <Card title="هذا الأسبوع" class="breath-card">
            <StateFrame
              state={sessionsQuery.state}
              stale={sessionsQuery.stale}
              empty={sessionsQuery.state !== 'loading' && sessions.length === 0}
              emptyText="لا جلسات بعد."
              emptyAction={<Button onClick={() => startRef.current?.focus()}>بدء جلسة</Button>}
              onRetry={sessionsQuery.reload}
              skeleton={
                <div class="week-skeleton">
                  <Skeleton round blockSize="112px" inlineSize="112px" />
                  <Skeleton inlineSize="60%" />
                </div>
              }
            >
              <WeekRing sessions={sessions} today={today} weekStart={WEEK_START} target={target} />
            </StateFrame>
          </Card>
          <ExhaleTest {...testProps('exhale')} />
          <HoldTest {...testProps('hold')} />
        </div>
      </div>
    </div>
  );
}
