import { navigate } from '../lib/navigate';

// One entry point for «اسأل»: the header button and both shortcuts call openAsk(). The side
// panel (task 20) subscribes with onAskOpen. Until something subscribes, the /ask page opens.
const listeners = new Set<() => void>();

export function openAsk(): void {
  if (listeners.size === 0) {
    navigate('/ask');
    return;
  }
  for (const listener of [...listeners]) listener();
}

/** Calls cb on every openAsk(). Returns the unsubscribe function. */
export function onAskOpen(cb: () => void): () => void {
  const listener = (): void => cb();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
