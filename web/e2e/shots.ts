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

/** No link is in the browser's own blue (or visited purple): every link has the app's colour. The
 *  default is what a link looks like when no rule names it (goals tree, due report, the mission
 *  card), and it is a colour outside the palette. */
export async function expectNoDefaultLinks(page: Page): Promise<void> {
  const defaults = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .filter((a) => (a as HTMLElement).offsetParent !== null || getComputedStyle(a).position === 'fixed')
      .map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 40), color: getComputedStyle(a).color }))
      .filter((a) => a.color === 'rgb(0, 0, 238)' || a.color === 'rgb(85, 26, 139)' || a.color === 'rgb(0, 102, 204)'),
  );
  expect(defaults, 'links in the default browser colour').toEqual([]);
}

/** The chosen option of every switch (a radio of a segmented control) is inside the window: a row of
 *  five views that scrolls sideways must not open with the chosen one out of sight. */
export async function expectActiveChoiceVisible(page: Page): Promise<void> {
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll('[role="radio"][aria-checked="true"]')]
      .map((el) => ({ name: (el.textContent ?? '').trim(), box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && (box.left < -0.5 || box.right > document.documentElement.clientWidth + 0.5))
      .map(({ name, box }) => `${name}: ${Math.round(box.left)}..${Math.round(box.right)}`),
  );
  expect(hidden, 'the chosen option of a switch is out of the window').toEqual([]);
}
