// The breath cue: one short tone from WebAudio when the phase changes, no audio file. It is off
// until the person turns it on, and the browser never plays it by itself: the audio context is made
// only by `prime()`, which the click that starts the session calls (an autoplay policy would keep a
// context made at any other time silent anyway). Without WebAudio every call does nothing.

import type { Phase } from './timing';

export interface Cue {
  /** Makes (or wakes) the audio context. Call it inside the click that starts the session. */
  prime(): void;
  /** A tone for the start of a phase: higher for the inhale, lower for the exhale. */
  play(phase: Phase): void;
  close(): void;
}

const PITCH: Readonly<Record<Phase, number>> = { inhale: 523.25, exhale: 392 };
const TONE_SECONDS = 0.22;
const PEAK_GAIN = 0.12;

type AudioContextConstructor = new () => AudioContext;

function contextClass(): AudioContextConstructor | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const g = globalThis as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  return g.AudioContext ?? g.webkitAudioContext;
}

export function createCue(): Cue {
  let context: AudioContext | null = null;

  return {
    prime() {
      try {
        if (context === null) {
          const Ctor = contextClass();
          if (Ctor === undefined) return;
          context = new Ctor();
        }
        if (context.state === 'suspended') void context.resume().catch(() => undefined);
      } catch {
        context = null;
      }
    },
    play(phase) {
      if (context === null || context.state === 'closed') return;
      try {
        const now = context.currentTime;
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + TONE_SECONDS);
        gain.connect(context.destination);
        const osc = context.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(PITCH[phase], now);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + TONE_SECONDS + 0.02);
      } catch {
        // a tone that cannot play must never stop the session
      }
    },
    close() {
      const current = context;
      context = null;
      if (current !== null) void current.close().catch(() => undefined);
    },
  };
}
