import './bubble.css';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Phase } from '../breath/timing';
import { fmt } from '../lib/format';
import { x } from './rtl';

export interface BreathBubbleProps {
  phase: Phase;
  /** How long the phase lasts, in seconds: it is the words «شهيق 4 ث». */
  phaseSeconds: number;
  /** What is left of it: the bubble reaches its size exactly when the phase ends. */
  secondsLeft: number;
  /** Whole breaths done: with the phase it tells the bubble a new phase has begun. */
  breaths: number;
  /** The person asked for less motion: the bubble stays still and the phase is words only. */
  reduced: boolean;
}

/** The inhale and the exhale in words, «شهيق 4 ث»: the length is shown to one decimal at most. */
export function phaseText(phase: Phase, seconds: number): string {
  return `${phase === 'inhale' ? 'شهيق' : 'زفير'} ${fmt.num(Math.round(seconds * 10) / 10)} ث`;
}

// The core circle grows to FULL on the inhale and shrinks to SMALL on the exhale.
const SMALL = 0.55;
const FULL = 1;
const STILL = 0.78;
const SIZE = 280;
// The bubble is centred, so mirroring leaves it where it is; its horizontal centre still goes
// through x() like every position a chart draws.
const CX = x(0, 1, SIZE);
const CY = SIZE / 2;

/** A bubble that widens through the inhale and narrows through the exhale. One CSS transition per
 *  phase carries it (its length is what is left of the phase), so the page does not redraw each
 *  frame. With reduced motion nothing moves: the words say the phase and its length. */
export function BreathBubble({ phase, phaseSeconds, secondsLeft, breaths, reduced }: BreathBubbleProps) {
  const text = phaseText(phase, phaseSeconds);

  // The length of the transition is fixed when the phase begins: the tick does not retime it.
  const key = `${breaths}:${phase}`;
  const seen = useRef('');
  const duration = useRef(secondsLeft);
  if (seen.current !== key) {
    seen.current = key;
    duration.current = secondsLeft;
  }

  // Drawn once at its starting size, then sent to its target: a transition needs a first state.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const target = phase === 'inhale' ? FULL : SMALL;
  const origin = phase === 'inhale' ? SMALL : FULL;
  let style: { transform: string; transitionDuration?: string } = { transform: `scale(${origin})` };
  if (reduced) style = { transform: `scale(${STILL})` };
  else if (armed) style = { transform: `scale(${target})`, transitionDuration: `${Number(duration.current.toFixed(2))}s` };

  return (
    <div class="breath-bubble-wrap">
      <svg
        class="chart breath-bubble"
        role="img"
        aria-label={`فقاعة التنفّس: ${text}`}
        data-motion={reduced ? 'reduced' : 'full'}
        data-phase={phase}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        focusable="false"
      >
        <circle class="bubble-halo" cx={CX} cy={CY} r={CY - 4} fill="none" stroke-width="2" />
        <circle class="bubble-core" cx={CX} cy={CY} r={CY - 24} style={style} />
      </svg>
      <p class="bubble-text num" aria-hidden="true">
        {text}
      </p>
    </div>
  );
}
