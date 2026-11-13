import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCue } from '../../src/breath/sound';

// A fake WebAudio: it counts the contexts made and the tones started.
let contexts = 0;
let tones = 0;
let frequencies: number[] = [];

class FakeContext {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  constructor() {
    contexts += 1;
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
  }
  createOscillator() {
    const osc = {
      type: 'sine',
      frequency: { value: 0, setValueAtTime: (v: number) => frequencies.push(v) },
      connect: vi.fn(),
      start: () => {
        tones += 1;
      },
      stop: vi.fn(),
    };
    return osc;
  }
}

beforeEach(() => {
  contexts = 0;
  tones = 0;
  frequencies = [];
  vi.stubGlobal('AudioContext', FakeContext);
});

afterEach(() => vi.unstubAllGlobals());

describe('the breath cue (a short WebAudio tone, no audio file, off until asked)', () => {
  it('makes no audio context until it is primed: the browser never autoplays', () => {
    const cue = createCue();
    expect(contexts).toBe(0);
    cue.play('inhale');
    expect(tones).toBe(0);
    expect(contexts).toBe(0);
  });

  it('is primed by the gesture that starts the session, then plays one short tone per phase', () => {
    const cue = createCue();
    cue.prime();
    expect(contexts).toBe(1);
    cue.play('inhale');
    cue.play('exhale');
    expect(tones).toBe(2);
    // Two different pitches: one for each phase.
    expect(new Set(frequencies).size).toBe(2);
  });

  it('priming twice makes one context, and close lets it go', async () => {
    const cue = createCue();
    cue.prime();
    cue.prime();
    expect(contexts).toBe(1);
    cue.close();
    cue.play('inhale');
    expect(tones).toBe(0);
  });

  it('does nothing, without an error, where WebAudio does not exist', () => {
    vi.stubGlobal('AudioContext', undefined);
    const cue = createCue();
    expect(() => {
      cue.prime();
      cue.play('inhale');
      cue.close();
    }).not.toThrow();
  });
});
