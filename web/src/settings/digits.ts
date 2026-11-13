// The digits setting (design 13.1, ruling 23): Latin by default, Arabic-Indic on request. `fmt`
// reads it in one place (`lib/format`); this module keeps the choice on this device, so a start
// without a connection still shows the digits that were chosen, and tells the app to draw again when
// it changes.

import { useEffect, useState } from 'preact/hooks';

import { kvGet, kvSet } from '../data/cache';
import { type Digits, getDigits, setDigits } from '../lib/format';

const KEY = 'digits';
const listeners = new Set<() => void>();

const isDigits = (value: unknown): value is Digits => value === 'latn' || value === 'arab';

/** Puts the digits in force, remembers them on this device, and redraws what listens. */
export function applyDigits(next: Digits, remember = true): void {
  if (next === getDigits()) return;
  setDigits(next);
  if (remember) void kvSet(KEY, next).catch(() => undefined);
  for (const listener of listeners) listener();
}

/** At the start: the digits this device remembers (the server's answer replaces them when it comes). */
export async function restoreDigits(): Promise<void> {
  const saved = await kvGet<unknown>(KEY).catch(() => undefined);
  if (isDigits(saved)) applyDigits(saved, false);
}

/** The digits in force; the component draws again when they change. */
export function useDigits(): Digits {
  const [current, setCurrent] = useState<Digits>(getDigits);
  useEffect(() => {
    const listener = (): void => setCurrent(getDigits());
    listeners.add(listener);
    // a change between the first render and this effect
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return current;
}
