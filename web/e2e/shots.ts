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
  const wide =
    scrollWidth <= clientWidth
      ? []
      : await page.evaluate(
          (limit) =>
            [...document.querySelectorAll<HTMLElement>('body *')]
              .filter((el) => el.getBoundingClientRect().right > limit + 1 && !el.closest('[data-scroller], .goals-switch, .timeline-scroll, .table-scroll'))
              .slice(0, 6)
              .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${Math.round(el.getBoundingClientRect().right)}`),
          clientWidth,
        );
  expect(scrollWidth, `the page is wider than the window: ${wide.join('; ')}`).toBeLessThanOrEqual(clientWidth);
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

/** Every control is at least 44 CSS pixels in its block size (the design's `--hit`, WCAG 2.5.5).
 *  Links inside a line of text are exempt (they are as tall as the text), and so is the skip link
 *  while it is off screen. Switches, buttons, chips, fields and rows are measured. */
export async function expectTargets44(page: Page): Promise<void> {
  const small = await page.evaluate(() => {
    const selector = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="radio"], [role="switch"], summary';
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue; // not drawn
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (el.classList.contains('skip-link') && box.bottom <= 0) continue;
      if (el.closest('svg')) continue;
      // an input drawn as a part of a bigger control (a hidden-looking checkbox of a switch)
      const label = el.closest('label');
      const hit = label ? label.getBoundingClientRect() : box;
      // a link inside a line of text is as tall as the text
      if (el.tagName === 'A' && !el.classList.contains('btn') && !el.classList.contains('nav-link') && getComputedStyle(el).display === 'inline') continue;
      if (Math.max(box.height, hit.height) < 43.5) {
        out.push(`${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0]} «${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}» ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    return out;
  });
  expect(small, 'controls shorter than 44 px').toEqual([]);
}

/** The open dialog or drawer is inside the window, and so is every action under its content: the
 *  body scrolls, the buttons never sit below the fold (Task 24: the Save button of the indicator
 *  dialog was cut by the bottom of the window at 1280x800 and 390x844). */
export async function expectLayerFits(page: Page): Promise<void> {
  // Measured at rest: the panel slides in for 200 ms.
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) // a skeleton shimmer never ends
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((resolve) => setTimeout(resolve, 1500)), // a long animation (a timer, a plant) does not hold the test
    ]),
  );
  const report = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.dialog, .drawer');
    if (!panel) return { found: false, problems: [] as string[] };
    const view = { w: document.documentElement.clientWidth, h: window.innerHeight };
    const problems: string[] = [];
    const inside = (name: string, box: DOMRect): void => {
      if (box.top < -0.5 || box.bottom > view.h + 0.5 || box.left < -0.5 || box.right > view.w + 0.5) {
        problems.push(`${name} ${Math.round(box.left)},${Math.round(box.top)} to ${Math.round(box.right)},${Math.round(box.bottom)} in ${view.w}x${view.h}`);
      }
    };
    inside('panel', panel.getBoundingClientRect());
    for (const button of panel.querySelectorAll<HTMLElement>('.layer-actions button, .layer-actions a')) {
      inside(`action «${(button.textContent ?? '').trim()}»`, button.getBoundingClientRect());
    }
    const body = panel.querySelector<HTMLElement>('.layer-body');
    if (!body || body.clientHeight < 40) problems.push('the body of the panel has no room');
    return { found: true, problems };
  });
  expect(report.found, 'a dialog or a drawer is open').toBe(true);
  expect(report.problems, 'parts of the panel outside the window').toEqual([]);
}
