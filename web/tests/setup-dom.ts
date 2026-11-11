// Runs before every test file. It only acts when the file opted into a DOM environment with
// `// @vitest-environment happy-dom`, so the node-environment suites are untouched.
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  // happy-dom ships no indexedDB; the sync queue and the session store need one.
  await import('fake-indexeddb/auto');
  const { act, cleanup } = await import('@testing-library/preact');
  // Testing Library only registers its own cleanup when vitest globals are on. They are off,
  // so unmount whatever a test rendered and empty the document after each one. Preact 11 defers
  // the cleanup of useEffect on unmount, so the unmount runs inside act(): by the time the next
  // test starts, no effect of this one is alive.
  afterEach(async () => {
    await act(async () => {
      cleanup();
    });
    document.body.replaceChildren();
  });
}
