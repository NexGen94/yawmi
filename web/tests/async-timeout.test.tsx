// @vitest-environment happy-dom
import { getConfig } from '@testing-library/preact';
import { expect, it } from 'vitest';

// The first vitest run after `npm ci` failed twice (a lazy page not drawn within 1 s, a flush not
// seen within 80 ms): on a cold machine the first import of a page, or a busy one, is slow. Under
// load the default wait of Testing Library (1000 ms) is a coin toss for any test that waits for a
// lazy page. The setup file raises it for every DOM test, so no test needs a figure of its own.
it('waits long enough for a lazy page to be imported on a cold or busy machine', () => {
  expect(getConfig().asyncUtilTimeout).toBeGreaterThanOrEqual(5000);
});
