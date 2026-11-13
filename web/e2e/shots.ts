import { expect, test, type Page } from '@playwright/test';

/** A full-page screenshot to `e2e/screenshots/<project>/<name>.png`. The folder is ignored by Git;
 *  the workflow uploads it as an artifact. */
export async function shot(page: Page, name: string): Promise<void> {
  const project = test.info().project.name;
  await page.screenshot({ path: `e2e/screenshots/${project}/${name}.png`, fullPage: true });
}

/** The page does not scroll sideways: its content is as wide as the window. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'the page is wider than the window').toBeLessThanOrEqual(clientWidth);
}
