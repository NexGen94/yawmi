import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One test at a time on state the whole server shares. The consent to the AI provider and the
// memory of the AI belong to the user, not to a device: a test that withdraws the consent for its
// own dialog withdraws it under any other test that is running (the other project, in another
// worker). The suite is one worker by default, where this costs nothing; with `--workers=N` the
// tests that touch shared state take turns, by a lock directory that `mkdir` makes atomically.

/** A lock older than this is a test that was killed holding it: it is taken over. */
const STALE_MS = 3 * 60_000;
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Takes the named lock, waiting for whoever holds it; returns the function that gives it back. */
export async function acquire(name: string, timeoutMs = 10 * 60_000): Promise<() => Promise<void>> {
  const dir = join(tmpdir(), `yawmi-e2e-${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(dir);
      return () => rm(dir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      if (Date.now() - (await stat(dir)).mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true });
    } catch {
      // it was given back between the two calls: try again at once
    }
    if (Date.now() > deadline) throw new Error(`the lock ${name} was not given back within ${timeoutMs} ms`);
    await sleep(POLL_MS);
  }
}
