import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Zero `serious` and `critical` axe violations on the page as it is now. Minor and moderate
 *  findings (a missing landmark, say) are not failures here; the report lists what it finds. */
export async function expectNoSeriousA11y(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(' ')),
    }));
  expect(blocking, 'serious or critical accessibility violations').toEqual([]);
}
