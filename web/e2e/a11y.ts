import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Zero `serious` and `critical` axe violations on the page as it is now, and no content outside a
 *  landmark (`region`: the brand was one, Task 9 M-3). The other moderate and minor findings are not
 *  failures here. */
export async function expectNoSeriousA11y(page: Page): Promise<void> {
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
