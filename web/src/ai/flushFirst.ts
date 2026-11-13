import { flush } from '../sync/outbox';

/** How long the close of the day waits for the queue to reach the server before it asks anyway. */
const WAIT_MS = 8000;

/** Sends the outbox before an AI call that reads what was just saved (the server builds its sources
 *  from stored data). It never throws and never waits long: a queue that cannot be sent (no
 *  connection, a refused batch) is left as it is, and the call goes on. */
export async function flushFirst(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, WAIT_MS);
  });
  try {
    await Promise.race([flush().then(() => undefined, () => undefined), limit]);
  } finally {
    clearTimeout(timer);
  }
}
