import { expect, test, type Page } from '@playwright/test';

/** A full-page screenshot to `<folder>/<project>/<name>.png`, the folder being `e2e/screenshots`
 *  (ignored by Git; the workflow uploads it as an artifact) or `YAWMI_SHOTS_DIR` when that is set. */
export async function shot(page: Page, name: string): Promise<void> {
  const project = test.info().project.name;
  const folder = process.env.YAWMI_SHOTS_DIR || 'e2e/screenshots';
  await page.screenshot({ path: `${folder}/${project}/${name}.png`, fullPage: true });
}

/** The page does not scroll sideways: its content is as wide as the window. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'the page is wider than the window').toBeLessThanOrEqual(clientWidth);
}
