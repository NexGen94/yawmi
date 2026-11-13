import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { type BreathSessionOut, personalAverage } from '../../breath/calc';
import type { TestCode } from '../../breath/patterns';
import { type BreathEndedPayload, testCap, testPayload } from '../../breath/timing';
import { useNow } from '../../breath/useClock';
import { fmt } from '../../lib/format';
import { Button } from '../../ui/Button';

export interface TimedTestProps {
  kind: TestCode;
  /** Every session known so far: the server's and this visit's. The mean is made of the tests among them. */
  sessions: readonly BreathSessionOut[];
  /** Another session or test is running. */
  disabled: boolean;
  startLabel: string;
  stopLabel: string;
  /** What is added to the result line, e.g. «رقم شخصي». */
  tail?: string;
  /** One test is running (true) or over (false): the page keeps the others quiet meanwhile. */
  onActive(active: boolean): void;
  /** The test is over: the page queues its event and keeps the session. */
  onDone(payload: BreathEndedPayload): void;
  children?: ComponentChildren;
}

const seconds = (n: number): string => fmt.count(n, 'second');

/** Shown instead of a result when the test lasted under a second. */
export const TOO_SHORT = 'المدة أقصر من ثانية، ولم يُسجَّل قياس';

/** A test measured by two taps: the first starts the clock, the second (or the cap of the test)
 *  stops it. The span is the difference of two timestamps, clamped to the cap before anything is
 *  queued. */
export function TimedTest({ kind, sessions, disabled, startLabel, stopLabel, tail, onActive, onDone, children }: TimedTestProps) {
  const cap = testCap(kind);
  const [startedMs, setStartedMs] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const running = startedMs !== null;
  const now = useNow(running);
  const done = useRef(false);
  const known = useRef(sessions);
  known.current = sessions;

  const stop = (endMs: number): void => {
    if (startedMs === null || done.current) return;
    done.current = true;
    const payload = testPayload(kind, startedMs, endMs);
    const spent = payload.duration_seconds ?? 0;
    // The mean of the tests before this one: a test is not part of its own comparison.
    const mean = personalAverage(known.current, kind);
    const compared = mean === null ? 'لا متوسط شخصي بعد' : `المتوسط الشخصي ${seconds(Math.round(mean))}`;
    setStartedMs(null);
    onActive(false);
    // A span under a second is a tap that did not mean to measure: it is not recorded, and the line
    // says so instead of showing a result that does not exist.
    if (spent < 1) {
      setResult(TOO_SHORT);
      return;
    }
    setResult([seconds(spent), compared, tail].filter(Boolean).join(' · '));
    onDone(payload);
  };

  useEffect(() => {
    if (startedMs !== null && now - startedMs >= cap * 1000) stop(now);
  });

  return (
    <div class="timed-test">
      {children}
      {startedMs !== null ? (
        <>
          <p class="test-clock num" role="timer">
            {seconds(Math.min(cap, Math.max(0, Math.floor((now - startedMs) / 1000))))}
          </p>
          <Button variant="primary" onClick={() => stop(Date.now())}>
            {stopLabel}
          </Button>
        </>
      ) : (
        <Button
          disabled={disabled}
          onClick={() => {
            done.current = false;
            setResult(null);
            setStartedMs(Date.now());
            onActive(true);
          }}
        >
          {startLabel}
        </Button>
      )}
      {result !== null && !running && <output class="test-result num">{result}</output>}
    </div>
  );
}
