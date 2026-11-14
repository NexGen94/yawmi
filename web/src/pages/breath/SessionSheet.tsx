import { useEffect, useRef } from 'preact/hooks';

import { MAX_MINUTES, MIN_MINUTES, type PatternCode, RATES } from '../../breath/patterns';
import type { Cue } from '../../breath/sound';
import { cycle, phaseAt } from '../../breath/timing';
import { useNow, useReducedMotion } from '../../breath/useClock';
import { BreathBubble } from '../../charts/BreathBubble';
import { fmt } from '../../lib/format';
import { OFFLINE_NOTE } from '../../lib/notes';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import { Segmented } from '../../ui/Segmented';
import { Slider } from '../../ui/Slider';

export interface SheetChoice {
  rate: number;
  minutes: number;
  sound: boolean;
}

export interface SessionSheetProps {
  choice: SheetChoice;
  onChange(patch: Partial<SheetChoice>): void;
  /** Another session or a test is running: the start is not offered. */
  disabled: boolean;
  /** The choices cannot be saved without a connection (a setting is never queued). */
  online: boolean;
  /** The save of the choices failed at the last start. */
  saveFailed: boolean;
  onStart(): void;
  startRef: { current: HTMLButtonElement | null };
}

const SOUND_LABEL = 'نغمة عند تبدّل المرحلة';

/** The sheet of one session before it starts: the rate, the length and the sound. «بدء» is the one
 *  prominent button of the page. */
export function SessionSheet({ choice, onChange, disabled, online, saveFailed, onStart, startRef }: SessionSheetProps) {
  return (
    <div class="session-sheet">
      <Segmented
        label="الوتيرة (نفس في الدقيقة)"
        options={RATES.map((rate) => ({ value: String(rate), label: fmt.num(rate) }))}
        value={String(choice.rate)}
        onChange={(value) => onChange({ rate: Number(value) })}
      />
      <Slider
        label="المدة"
        min={MIN_MINUTES}
        max={MAX_MINUTES}
        value={choice.minutes}
        onChange={(minutes) => onChange({ minutes })}
        valueText={(minutes) => fmt.count(minutes, 'minute')}
      />
      <Switch checked={choice.sound} onChange={(sound) => onChange({ sound })} label={SOUND_LABEL} />
      <div class="breath-actions">
        <button ref={startRef} type="button" class="btn btn-primary btn-start" disabled={disabled} onClick={onStart}>
          بدء
        </button>
        {!online && <span class="breath-hint">{`حفظ الاختيارات: ${OFFLINE_NOTE}`}</span>}
        {online && saveFailed && <span class="breath-hint">تعذّر حفظ الاختيارات</span>}
      </div>
    </div>
  );
}

const clock = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${fmt.num(Math.floor(total / 60))}:${fmt.num(total % 60, { minimumIntegerDigits: 2 })}`;
};

export interface SessionRunProps {
  pattern: PatternCode;
  rate: number;
  minutes: number;
  /** When the session began, by the clock. */
  startedMs: number;
  /** Plays a tone at each change of phase; absent while the sound is off. */
  cue: Cue | null;
  /** The session is over: the planned length is reached, or the end was asked for. `elapsedMs` is the
   *  time measured from the start. */
  onEnd(elapsedMs: number): void;
}

/** A session in progress: the bubble, the phase in words, what is left. Every number is computed
 *  from `startedMs` and the clock, so a tab that slept reads the right phase when it wakes, and a
 *  session never lasts longer than it was planned. */
export function SessionRun({ pattern, rate, minutes, startedMs, cue, onEnd }: SessionRunProps) {
  const now = useNow(true);
  const reduced = useReducedMotion();
  const phases = cycle(pattern, rate);
  const plannedMs = minutes * 60_000;
  const elapsedMs = now - startedMs;
  const position = phaseAt(phases, elapsedMs / 1000);
  const over = elapsedMs >= plannedMs;

  const ended = useRef(false);
  const finish = (ms: number): void => {
    if (ended.current) return;
    ended.current = true;
    onEnd(ms);
  };
  useEffect(() => {
    if (over) finish(elapsedMs);
  });

  const phaseKey = `${position.breaths}:${position.phase}`;
  const lastKey = useRef('');
  useEffect(() => {
    if (lastKey.current === phaseKey) return;
    lastKey.current = phaseKey;
    if (!ended.current) cue?.play(position.phase);
  }, [phaseKey, cue, position.phase]);

  return (
    <div class="session-run">
      <BreathBubble
        phase={position.phase}
        phaseSeconds={position.phaseSeconds}
        secondsLeft={position.secondsLeft}
        breaths={position.breaths}
        reduced={reduced}
      />
      <p class="breath-left num">{`المتبقي ${clock(plannedMs - elapsedMs)}`}</p>
      <Button onClick={() => finish(Date.now() - startedMs)}>إنهاء</Button>
    </div>
  );
}
