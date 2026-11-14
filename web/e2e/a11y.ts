import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Waits until the finite animations and transitions of the page are over, for at most 1.5 s. A skeleton
 *  shimmer never ends, a timer or a plant may run long, and a test with a fake clock must not depend on
 *  the page's own timers: the limit is counted here, in the test process. */
export async function settleAnimations(page: Page): Promise<void> {
  const over = page
    .evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    )
    .catch(() => undefined);
  await Promise.race([over, new Promise((resolve) => setTimeout(resolve, 1500))]);
}

/** Zero `serious` and `critical` axe violations on the page as it is now, and no content outside a
 *  landmark (`region`: the brand was one, Task 9 M-3). The other moderate and minor findings are not
 *  failures here. */
export async function expectNoSeriousA11y(page: Page): Promise<void> {
  // Colours are read at rest: a button fading from one colour to another would be measured halfway.
  await settleAnimations(page);
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical' || v.id === 'region')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(' ')),
    }));
  expect(blocking, 'serious or critical accessibility violations').toEqual([]);
}
