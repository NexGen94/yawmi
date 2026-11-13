// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { LocationProvider } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { components } from '../../src/api/schema';
import { writeCache } from '../../src/data/cache';
import { PATTERNS } from '../../src/breath/patterns';
import { fmt } from '../../src/lib/format';
import BreathPage from '../../src/pages/breath';
import { closeDb, listPending } from '../../src/sync/outbox';
import { type Handler, json, settings, stubServer } from '../helpers/ai-fixtures';

// The timer behind scheduleFlush would outlive a test, and nothing is sent here: the outbox is read.
vi.mock('../../src/sync/outbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/sync/outbox')>();
  return { ...original, scheduleFlush: vi.fn() };
});

type Session = components['schemas']['BreathSessionOut'];

// 12:00 in Riyadh on Tuesday 2026-11-10: the focus hour, in the week 2026-11-08 to 2026-11-14.
const NOW = Date.parse('2026-11-10T09:00:00Z');
const TODAY = '2026-11-10';
const SAFETY =
  'يُوقَف التمرين عند الدوار أو التنميل. لا يُمارَس أثناء القيادة. ومن لديه مرض في القلب أو الرئة، أو حمل، أو اضطراب هلع، يستشير طبيباً.';

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  // A session still waiting for its answer is queued when its page unmounts: let that finish here,
  // before the next test opens its own database.
  await act(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  closeDb();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let seq = 0;
function sess(over: Partial<Session> = {}): Session {
  seq += 1;
  const day = over.day ?? '2026-11-09';
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    day,
    started_at: `${day}T09:00:00Z`,
    ended_at: `${day}T09:10:00Z`,
    pattern: 'calm',
    breaths_per_min: 6,
    duration_seconds: 600,
    completed: true,
    feeling: null,
    ...over,
  };
}

function serve(options: { sessions?: Session[]; settings?: Partial<components['schemas']['SettingsOut']>; over?: Record<string, Handler> } = {}) {
  return stubServer({
    'GET /v1/settings': () => json(settings(options.settings)),
    'GET /v1/breath/sessions': () => json({ items: options.sessions ?? [] }),
    'PATCH /v1/settings': (call) => json(settings({ ...options.settings, ...(call.body as object) })),
    ...options.over,
  });
}

async function openPage(): Promise<{ unmount(): void }> {
  const view = render(
    <LocationProvider>
      <BreathPage />
    </LocationProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'التنفّس' });
  return view;
}

/** The sessions of the server are in: the dots of the week are drawn only then. */
const loaded = (): Promise<HTMLElement> => screen.findByRole('list', { name: 'جلسات الأسبوع' });

const RATE_GROUP = 'الوتيرة (نفس في الدقيقة)';
const rateText = (rate: number): string => fmt.num(rate);

const radio = (group: string, name: string): HTMLElement => within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });
const checked = (group: string): string =>
  within(screen.getByRole('radiogroup', { name: group }))
    .getAllByRole('radio')
    .filter((r) => r.getAttribute('aria-checked') === 'true')
    .map((r) => r.textContent)
    .join('|');
const start = (): boolean => fireEvent.click(screen.getByRole('button', { name: 'بدء' }));
const at = (ms: number): void => {
  vi.setSystemTime(NOW + ms);
};
const chooseMinutes = (minutes: number): boolean => fireEvent.input(screen.getByRole('slider', { name: 'المدة' }), { target: { value: String(minutes) } });

async function breathEvents(): Promise<{ id: string; payload: components['schemas']['BreathEndedPayload'] }[]> {
  const all = await listPending();
  return all.filter((e) => e.type === 'breath_ended').map((e) => ({ id: e.id, payload: e.payload as components['schemas']['BreathEndedPayload'] }));
}

/** A one-minute session, played to its end by the clock. */
async function playMinute(): Promise<void> {
  chooseMinutes(1);
  start();
  await screen.findByRole('img', { name: /فقاعة التنفّس/ });
  at(60_000);
  await screen.findByRole('group', { name: 'الشعور بعد الجلسة' });
}

describe('the styles, the rates and the length', () => {
  it('shows the six styles by their labels, the style of the hour chosen, as a radio group', async () => {
    serve();
    await openPage();
    const group = screen.getByRole('radiogroup', { name: 'الأسلوب' });
    const labels = within(group)
      .getAllByRole('radio')
      .map((r) => r.textContent);
    expect(labels).toEqual(['تهدئة', 'تركيز', 'تهيئة للنوم', 'تنشيط الصباح', 'بعد العمل', 'قبل موقف مهم']);
    // Noon in Riyadh: the hour asks for «تركيز».
    expect(checked('الأسلوب')).toBe('تركيز');
  });

  it('the hour decides the style that is chosen at first: 22:00 is the sleep style at its own rate', async () => {
    vi.setSystemTime(Date.parse('2026-11-10T19:00:00Z')); // 22:00 in Riyadh
    serve();
    await openPage();
    expect(checked('الأسلوب')).toBe('تهيئة للنوم');
    expect(checked(RATE_GROUP)).toBe('5');
  });

  it('shows the four rates with the default of the style chosen, and choosing a style brings its rate', async () => {
    serve();
    await openPage();
    const rates = within(screen.getByRole('radiogroup', { name: RATE_GROUP }))
      .getAllByRole('radio')
      .map((r) => r.textContent);
    expect(rates).toEqual([5, 5.5, 6, 6.5].map(rateText));
    expect(checked(RATE_GROUP)).toBe('6'); // the focus style
    fireEvent.click(radio('الأسلوب', 'بعد العمل'));
    expect(checked(RATE_GROUP)).toBe(rateText(5.5));
    fireEvent.click(radio('الأسلوب', 'تنشيط الصباح'));
    expect(checked(RATE_GROUP)).toBe(rateText(6.5));
    fireEvent.click(radio(RATE_GROUP, '5'));
    expect(checked(RATE_GROUP)).toBe('5');
  });

  it('the length is a slider from 1 to 10 minutes', async () => {
    serve();
    await openPage();
    const slider = screen.getByRole('slider', { name: 'المدة' });
    expect(slider.getAttribute('min')).toBe('1');
    expect(slider.getAttribute('max')).toBe('10');
    chooseMinutes(7);
    expect(slider.getAttribute('aria-valuetext')).toBe(fmt.count(7, 'minute'));
  });

  it('each style says how long the inhale and the exhale are at the rate chosen', async () => {
    serve();
    await openPage();
    fireEvent.click(radio('الأسلوب', 'تهدئة'));
    fireEvent.click(radio(RATE_GROUP, '6'));
    expect(screen.getByText('شهيق 4 ث · زفير 6 ث')).toBeTruthy();
    fireEvent.click(radio('الأسلوب', 'قبل موقف مهم'));
    expect(screen.getByText('شهيق 3.3 ث · زفير 6.7 ث')).toBeTruthy();
  });
});

describe('the choices are kept with PATCH /v1/settings (breath_prefs)', () => {
  it('starting with other choices saves the four of them, and the next visit shows them', async () => {
    const s = serve();
    const first = await openPage();
    fireEvent.click(radio('الأسلوب', 'بعد العمل'));
    fireEvent.click(radio(RATE_GROUP, '6'));
    chooseMinutes(3);
    fireEvent.click(screen.getByRole('switch', { name: 'نغمة عند تبدّل المرحلة' }));
    start();
    await waitFor(() => expect(s.of('PATCH', '/v1/settings')).toHaveLength(1));
    expect(s.of('PATCH', '/v1/settings')[0]?.body).toEqual({ breath_prefs: { pattern: 'unwind', minutes: 3, rate: 6, sound: true } });

    // The next visit: the server returns them, and they are the choices.
    first.unmount();
    at(0);
    serve({ settings: { breath_prefs: { pattern: 'unwind', minutes: 3, rate: 6, sound: true } } });
    await openPage();
    await waitFor(() => expect(checked('الأسلوب')).toBe('بعد العمل'));
    expect(checked(RATE_GROUP)).toBe('6');
    expect(screen.getByRole('slider', { name: 'المدة' }).getAttribute('aria-valuetext')).toBe(fmt.count(3, 'minute'));
    expect(screen.getByRole('switch', { name: 'نغمة عند تبدّل المرحلة' }).getAttribute('aria-checked')).toBe('true');
  });

  it('nothing is sent when the choices are the ones already saved', async () => {
    const s = serve({ settings: { breath_prefs: { pattern: 'calm', minutes: 5, rate: 6, sound: false } } });
    await openPage();
    await waitFor(() => expect(checked('الأسلوب')).toBe('تهدئة'));
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    expect(s.of('PATCH', '/v1/settings')).toHaveLength(0);
  });

  it('a style that is not one of the six, or a rate outside the four, is not taken from the server', async () => {
    serve({ settings: { breath_prefs: { pattern: 'box' as 'calm', minutes: 5, rate: 9, sound: false } } });
    await openPage();
    await screen.findByText('لا جلسات بعد.');
    expect(checked('الأسلوب')).toBe('تركيز');
    expect(checked(RATE_GROUP)).toBe('6');
  });

  it('the sound is off at first', async () => {
    serve();
    await openPage();
    expect(screen.getByRole('switch', { name: 'نغمة عند تبدّل المرحلة' }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('a session: the bubble, the clock, the check-in', () => {
  it('starting shows the bubble and the phase with its length; the clock moves it to the exhale', async () => {
    serve();
    await openPage();
    fireEvent.click(radio('الأسلوب', 'تهدئة'));
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    expect(screen.getByText('شهيق 4 ث')).toBeTruthy();
    at(4_000);
    await screen.findByText('زفير 6 ث');
    at(10_000);
    await screen.findByText('شهيق 4 ث');
  });

  it('after the session three choices: «أهدأ», «كما كان», «أكثر توتراً»', async () => {
    serve();
    await openPage();
    await playMinute();
    const group = screen.getByRole('group', { name: 'الشعور بعد الجلسة' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['أهدأ', 'كما كان', 'أكثر توتراً']);
    expect(screen.getByRole('button', { name: 'تجاوز' })).toBeTruthy();
    // Nothing is queued until the choice is made.
    expect(await breathEvents()).toHaveLength(0);
  });

  it('choosing one adds one breath_ended with the feeling, the rate and the style', async () => {
    serve();
    await openPage();
    fireEvent.click(radio('الأسلوب', 'تهدئة'));
    await playMinute();
    fireEvent.click(screen.getByRole('button', { name: 'أهدأ' }));
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    const [event] = await breathEvents();
    expect(event?.payload).toMatchObject({ pattern: 'calm', breaths_per_min: 6, feeling: 'calmer', duration_seconds: 60, completed: true });
    expect(event?.payload.started_at).toBe(new Date(NOW).toISOString());
    expect(event?.payload.ended_at).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('each of the three choices gives its feeling', async () => {
    const wanted: [string, string][] = [
      ['أهدأ', 'calmer'],
      ['كما كان', 'same'],
      ['أكثر توتراً', 'tense'],
    ];
    serve();
    for (const [label, feeling] of wanted) {
      const view = await openPage();
      await playMinute();
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(async () => expect((await breathEvents()).map((e) => e.payload.feeling)).toContain(feeling));
      view.unmount();
      at(0);
    }
    expect((await breathEvents()).map((e) => e.payload.feeling).sort()).toEqual(['calmer', 'same', 'tense']);
  });

  it('skipping it adds the event with feeling null, and only once', async () => {
    serve();
    await openPage();
    await playMinute();
    const skip = screen.getByRole('button', { name: 'تجاوز' });
    fireEvent.click(skip);
    fireEvent.click(skip);
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload.feeling).toBeNull();
  });

  it('leaving the page before answering keeps the session, with no feeling', async () => {
    serve();
    const view = await openPage();
    await playMinute();
    await act(async () => {
      view.unmount();
    });
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload).toMatchObject({ feeling: null, duration_seconds: 60 });
  });

  it('leaving the page mid-session records it as not completed, like «إنهاء», with no feeling', async () => {
    serve();
    const view = await openPage();
    chooseMinutes(5);
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    at(95_000);
    await act(async () => {
      view.unmount();
    });
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    const [event] = await breathEvents();
    expect(event?.payload).toMatchObject({ pattern: 'focus', duration_seconds: 95, completed: false, feeling: null, breaths_per_min: 6 });
    expect(event?.payload.ended_at).toBe(new Date(NOW + 95_000).toISOString());
  });

  it('leaving a session of under a second records nothing', async () => {
    serve();
    const view = await openPage();
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    at(400);
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(await breathEvents()).toHaveLength(0);
  });

  it('a session that was ended and answered is not recorded again by leaving', async () => {
    serve();
    const view = await openPage();
    await playMinute();
    fireEvent.click(screen.getByRole('button', { name: 'أهدأ' }));
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(await breathEvents()).toHaveLength(1);
  });

  it('ending early is a session that did not complete, with the seconds that passed', async () => {
    serve();
    await openPage();
    chooseMinutes(5);
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    at(95_000);
    fireEvent.click(screen.getByRole('button', { name: 'إنهاء' }));
    await screen.findByRole('group', { name: 'الشعور بعد الجلسة' });
    fireEvent.click(screen.getByRole('button', { name: 'كما كان' }));
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload).toMatchObject({ duration_seconds: 95, completed: false, feeling: 'same' });
  });

  it('the clock is the timestamps: a session whose ticks stopped for ten minutes still ends at its planned length', async () => {
    serve();
    await openPage();
    chooseMinutes(1);
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    at(10 * 60_000); // the tab slept; no tick ran in between
    await screen.findByRole('group', { name: 'الشعور بعد الجلسة' });
    fireEvent.click(screen.getByRole('button', { name: 'أهدأ' }));
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    const [event] = await breathEvents();
    expect(event?.payload.duration_seconds).toBe(60);
    expect(event?.payload.ended_at).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('a named style never sends a rate outside 5 to 6.5: each of the six at its own rate', async () => {
    serve();
    await openPage();
    const seen = new Set<string>();
    for (const [code, { label, rate }] of Object.entries(PATTERNS)) {
      fireEvent.click(radio('الأسلوب', label));
      await playMinute();
      fireEvent.click(screen.getByRole('button', { name: 'تجاوز' }));
      await waitFor(async () => expect((await breathEvents()).filter((e) => !seen.has(e.id))).toHaveLength(1));
      const [fresh] = (await breathEvents()).filter((e) => !seen.has(e.id));
      seen.add(fresh?.id ?? '');
      expect(fresh?.payload).toMatchObject({ pattern: code, breaths_per_min: rate });
      await screen.findByRole('button', { name: 'بدء' });
      at(0);
    }
    expect(seen.size).toBe(6);
    for (const event of await breathEvents()) {
      expect(event.payload.breaths_per_min).toBeGreaterThanOrEqual(5);
      expect(event.payload.breaths_per_min).toBeLessThanOrEqual(6.5);
    }
  }, 30_000);

  it('the focus goes to the session, then to the check-in, then back to the start', async () => {
    serve();
    await openPage();
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    expect(document.activeElement?.closest('[data-stage="running"]')).not.toBeNull();
    at(5_000);
    fireEvent.click(screen.getByRole('button', { name: 'إنهاء' }));
    await screen.findByRole('group', { name: 'الشعور بعد الجلسة' });
    expect(document.activeElement?.closest('[data-stage="checkin"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'تجاوز' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'بدء' })));
  });
});

describe('reduced motion and sound', () => {
  function media(reduce: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }

  it('with prefers-reduced-motion the phase is text, «شهيق 4 ث», and the bubble does not move', async () => {
    media(true);
    serve();
    await openPage();
    fireEvent.click(radio('الأسلوب', 'تهدئة'));
    start();
    const bubble = await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    expect(bubble.getAttribute('data-motion')).toBe('reduced');
    expect(bubble.getAttribute('aria-label')).toContain('شهيق 4 ث');
    expect(screen.getByText('شهيق 4 ث')).toBeTruthy();
    expect((bubble.querySelector('.bubble-core') as unknown as SVGElement).style.transitionDuration).toBe('');
    at(4_000);
    await screen.findByText('زفير 6 ث');
    expect(screen.queryByText('شهيق 4 ث')).toBeNull();
  });

  it('without it the bubble moves through the length of the phase', async () => {
    media(false);
    serve();
    await openPage();
    fireEvent.click(radio('الأسلوب', 'تهدئة'));
    start();
    const bubble = await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    expect(bubble.getAttribute('data-motion')).toBe('full');
    await waitFor(() => expect((bubble.querySelector('.bubble-core') as unknown as SVGElement).style.transitionDuration).toBe('4s'));
  });

  it('the sound is not made at all when it is off', async () => {
    const made = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          made();
        }
      },
    );
    serve();
    await openPage();
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    at(5_000); // the focus style at 6 is five seconds in, five out
    await screen.findByText('زفير 5 ث');
    expect(made).not.toHaveBeenCalled();
  });

  it('with the sound on, the start click makes the context and the phase change plays a tone', async () => {
    const made = vi.fn();
    const tones = vi.fn();
    class FakeContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      constructor() {
        made();
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      createGain() {
        return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
      }
      createOscillator() {
        return { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: tones, stop: vi.fn() };
      }
    }
    vi.stubGlobal('AudioContext', FakeContext);
    serve();
    await openPage();
    fireEvent.click(radio('الأسلوب', 'تهدئة'));
    fireEvent.click(screen.getByRole('switch', { name: 'نغمة عند تبدّل المرحلة' }));
    expect(made).not.toHaveBeenCalled(); // choosing it is not yet a sound
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    expect(made).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(tones).toHaveBeenCalledTimes(1)); // the first inhale
    at(4_000);
    await waitFor(() => expect(tones).toHaveBeenCalledTimes(2));
  });
});

describe('the weekly ring and the dots', () => {
  it('«18 من 30 دقيقة» with a target of 30, and the ring says 60%', async () => {
    serve({
      settings: { breath_weekly_target_min: 30 },
      sessions: [sess({ day: '2026-11-08', duration_seconds: 600 }), sess({ day: TODAY, pattern: 'sleep', duration_seconds: 480 })],
    });
    await openPage();
    await screen.findByText('18 من 30 دقيقة');
    expect(screen.getByRole('img', { name: /دقائق التنفّس هذا الأسبوع/ }).getAttribute('aria-label')).toContain('60%');
  });

  it('the hold test and the exhale test do not add to the minutes', async () => {
    serve({
      settings: { breath_weekly_target_min: 30 },
      sessions: [sess({ duration_seconds: 1080 }), sess({ pattern: 'hold_test', duration_seconds: 30 }), sess({ pattern: 'exhale_test', duration_seconds: 40 })],
    });
    await openPage();
    expect(await screen.findByText('18 من 30 دقيقة')).toBeTruthy();
  });

  it('with no target the number stands alone', async () => {
    serve({ sessions: [sess({ duration_seconds: 1080 })] });
    await openPage();
    await screen.findByText('18 دقيقة');
    expect(screen.queryByText(/من 30/)).toBeNull();
    expect(screen.queryByRole('img', { name: /دقائق التنفّس هذا الأسبوع/ })).toBeNull();
  });

  it('the dots show the days of the week that have a session, by shape and by words', async () => {
    serve({ sessions: [sess({ day: '2026-11-08' }), sess({ day: '2026-11-10' }), sess({ day: '2026-11-09', pattern: 'hold_test', duration_seconds: 20 })] });
    await openPage();
    const list = await screen.findByRole('list', { name: 'جلسات الأسبوع' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(7);
    expect(items[0]?.textContent).toContain(fmt.day('2026-11-08'));
    expect(items.map((i) => i.getAttribute('data-done'))).toEqual(['true', 'false', 'true', 'false', 'false', 'false', 'false']);
    expect(items[0]?.textContent).toContain('جلسة');
    expect(items[1]?.textContent).toContain('بلا جلسة');
  });

  it('a session finished now adds its minutes at once, before the server holds it', async () => {
    serve({ settings: { breath_weekly_target_min: 30 }, sessions: [sess({ day: '2026-11-08', duration_seconds: 600 })] });
    await openPage();
    await screen.findByText('10 من 30 دقيقة');
    await playMinute();
    fireEvent.click(screen.getByRole('button', { name: 'أهدأ' }));
    expect(await screen.findByText('11 من 30 دقيقة')).toBeTruthy();
  });
});

describe('the exhale test', () => {
  it('two taps record the seconds between them as exhale_test, and the personal mean is shown', async () => {
    serve({ sessions: [sess({ pattern: 'exhale_test', duration_seconds: 12 }), sess({ pattern: 'exhale_test', duration_seconds: 18 })] });
    await openPage();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الزفير' }));
    at(18_000);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الزفير' }));
    await screen.findByText('18 ث · المتوسط الشخصي 15 ث');
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload).toMatchObject({
      pattern: 'exhale_test',
      duration_seconds: 18,
      completed: true,
      feeling: null,
      breaths_per_min: null,
    });
  });

  it('stops by itself at 60 seconds and records 60', async () => {
    serve();
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الزفير' }));
    at(75_000); // the tab slept past the cap
    await screen.findByText(/^60 ث/);
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload).toMatchObject({ pattern: 'exhale_test', duration_seconds: 60 });
    expect(screen.getByRole('button', { name: 'بدء الزفير' })).toBeTruthy();
  });

  it('a tap that comes after the cap (before any tick) is still recorded as 60', async () => {
    serve();
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الزفير' }));
    at(61_900);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الزفير' }));
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload.duration_seconds).toBe(60);
  });

  it('with no earlier test there is no mean to compare with', async () => {
    serve();
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الزفير' }));
    at(18_000);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الزفير' }));
    expect(await screen.findByText('18 ث · لا متوسط شخصي بعد')).toBeTruthy();
  });

  it('a tap of under a second shows no result and records nothing, and says why', async () => {
    serve();
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الزفير' }));
    at(400);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الزفير' }));
    expect(await screen.findByText('المدة أقصر من ثانية، ولم يُسجَّل قياس')).toBeTruthy();
    expect(screen.queryByText(/^0 ث/)).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(await breathEvents()).toHaveLength(0);
    // And a real test after it works as usual.
    at(0);
    fireEvent.click(screen.getByRole('button', { name: 'بدء الزفير' }));
    at(18_000);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الزفير' }));
    expect(await screen.findByText('18 ث · لا متوسط شخصي بعد')).toBeTruthy();
    expect(screen.queryByText('المدة أقصر من ثانية، ولم يُسجَّل قياس')).toBeNull();
  });

  it('a second test is compared with the first one of this visit too', async () => {
    serve();
    await openPage();
    for (const [i, seconds] of [10, 20].entries()) {
      at(0);
      fireEvent.click(screen.getByRole('button', { name: 'بدء الزفير' }));
      at(seconds * 1000);
      fireEvent.click(screen.getByRole('button', { name: 'انتهاء الزفير' }));
      await waitFor(() => expect(screen.getByText(new RegExp(`^${seconds} ث`))).toBeTruthy());
      // The first one is in the queue, and so in the list of the visit, before the next begins.
      await waitFor(async () => expect(await breathEvents()).toHaveLength(i + 1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    await screen.findByText('20 ث · المتوسط الشخصي 10 ث');
  });
});

describe('the hold test', () => {
  it('sits in a closed «اختبار اختياري» disclosure, with the note above its button', async () => {
    serve();
    await openPage();
    const summary = screen.getByText('اختبار اختياري');
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    const note = screen.getByText('يمكن التوقف في أي لحظة');
    const button = screen.getByRole('button', { name: 'بدء الحبس' });
    expect(details?.contains(note)).toBe(true);
    expect(details?.contains(button)).toBe(true);
    // The note is above the button in the page.
    expect(note.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('two taps record 24 seconds as hold_test, shown with the personal mean and «رقم شخصي»', async () => {
    serve({ sessions: [sess({ pattern: 'hold_test', duration_seconds: 21 })] });
    await openPage();
    await loaded();
    fireEvent.click(screen.getByText('اختبار اختياري'));
    fireEvent.click(screen.getByRole('button', { name: 'بدء الحبس' }));
    at(24_000);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الحبس' }));
    await screen.findByText('24 ث · المتوسط الشخصي 21 ث · رقم شخصي');
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload).toMatchObject({ pattern: 'hold_test', duration_seconds: 24, completed: true });
  });

  it('stops by itself at 30 seconds', async () => {
    serve();
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الحبس' }));
    at(45_000);
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload).toMatchObject({ pattern: 'hold_test', duration_seconds: 30 });
  });

  it('an overshoot of 30.4 seconds is queued as 30', async () => {
    serve();
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الحبس' }));
    at(30_400);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الحبس' }));
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
    expect((await breathEvents())[0]?.payload.duration_seconds).toBe(30);
  });

  it('a hold tap of under a second shows no result and records nothing', async () => {
    serve();
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الحبس' }));
    at(300);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الحبس' }));
    expect(await screen.findByText('المدة أقصر من ثانية، ولم يُسجَّل قياس')).toBeTruthy();
    expect(screen.queryByText(/^0 ث/)).toBeNull();
    expect(document.body.textContent).not.toContain('رقم شخصي');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(await breathEvents()).toHaveLength(0);
  });

  it('no text on the page calls the result a score or a health figure', async () => {
    serve({ sessions: [sess({ pattern: 'hold_test', duration_seconds: 21 })] });
    await openPage();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الحبس' }));
    at(24_000);
    fireEvent.click(screen.getByRole('button', { name: 'انتهاء الحبس' }));
    await screen.findByText(/24 ث/);
    expect(document.body.textContent).not.toMatch(/درجة|صحي/);
  });

  it('while a test or a session is running the other starts are not offered', async () => {
    serve();
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'بدء الزفير' }));
    expect(screen.getByRole('button', { name: 'بدء الحبس' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'بدء' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('the safety text and the four states', () => {
  it('the safety text is always on the page: loading, ready, error, offline', async () => {
    serve();
    render(
      <LocationProvider>
        <BreathPage />
      </LocationProvider>,
    );
    // loading: the first paint
    expect(screen.getByText(SAFETY)).toBeTruthy();
    await screen.findByText(/لا جلسات/);
    expect(screen.getByText(SAFETY)).toBeTruthy();
  });

  it('loading draws placeholders of the week and marks the section busy', async () => {
    serve({ over: { 'GET /v1/breath/sessions': () => new Promise<Response>(() => undefined) } });
    await openPage();
    const week = screen.getByRole('region', { name: 'هذا الأسبوع' });
    expect(week.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText(SAFETY)).toBeTruthy();
  });

  it('empty: says what is missing', async () => {
    serve();
    await openPage();
    await screen.findByText('لا جلسات بعد.');
    expect(screen.getByText(SAFETY)).toBeTruthy();
  });

  it('error: «تعذّر التحميل» with a retry, and no raw code', async () => {
    let fail = true;
    serve({ over: { 'GET /v1/breath/sessions': () => (fail ? json({ detail: 'x' }, 500) : json({ items: [sess({ duration_seconds: 120 })] })) } });
    await openPage();
    await screen.findByText('تعذّر التحميل');
    expect(screen.queryByText(/500|HTTP/)).toBeNull();
    expect(screen.getByText(SAFETY)).toBeTruthy();
    // A session can still be started.
    expect(screen.getByRole('button', { name: 'بدء' }).hasAttribute('disabled')).toBe(false);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByText(fmt.count(2, 'minute'));
  });

  it('offline with a saved copy: the copy and the badge', async () => {
    await writeCache('breath-sessions', [sess({ duration_seconds: 600 })]);
    serve({ over: { 'GET /v1/breath/sessions': () => Promise.reject(new TypeError('offline')), 'GET /v1/settings': () => Promise.reject(new TypeError('offline')) } });
    await openPage();
    await screen.findByText('نسخة محفوظة · بلا اتصال');
    expect(screen.getByText(SAFETY)).toBeTruthy();
  });

  it('offline with no copy: «لا نسخة محفوظة بعد», and a session still works', async () => {
    serve({ over: { 'GET /v1/breath/sessions': () => Promise.reject(new TypeError('offline')), 'GET /v1/settings': () => Promise.reject(new TypeError('offline')) } });
    await openPage();
    await screen.findByText('لا نسخة محفوظة بعد');
    expect(screen.getByText(SAFETY)).toBeTruthy();
    await playMinute();
    fireEvent.click(screen.getByRole('button', { name: 'أهدأ' }));
    await waitFor(async () => expect(await breathEvents()).toHaveLength(1));
  });

  it('offline, the choices cannot be saved and the page says so with the shared words', async () => {
    const s = serve();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openPage();
    expect(screen.getByText(/يحتاج اتصالاً/)).toBeTruthy();
    chooseMinutes(3);
    start();
    await screen.findByRole('img', { name: /فقاعة التنفّس/ });
    expect(s.of('PATCH', '/v1/settings')).toHaveLength(0);
  });
});
