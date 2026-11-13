import type { Page, Route } from '@playwright/test';

import { expectNoSeriousA11y } from './a11y';
import { expect, PROJECT_DATA, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

// Every route of design section 3, in its three states: as loaded, with the server failing, and
// offline from the saved copy. Each state gets the same three checks: no serious or critical axe
// violation, no sideways scroll (the 390 project is the one that can fail it), and a screenshot
// that the design review reads. The screens' own journeys live in the other specs; this one is the
// sweep that visits them all.

interface PageCase {
  /** The name of the screenshots. */
  slug: string;
  /** The path to visit; a function when the project's own habit is in it. */
  path: string | ((habit: string) => string);
  /** The page heading (`h1`). */
  heading: string | RegExp;
}

const CASES: readonly PageCase[] = [
  { slug: 'home', path: '/', heading: 'الرئيسية' },
  { slug: 'day-morning', path: '/day/morning', heading: 'اليوم' },
  { slug: 'day-evening', path: '/day/evening', heading: 'اليوم' },
  { slug: 'day', path: '/day', heading: 'اليوم' },
  { slug: 'habits', path: '/habits', heading: 'العادات' },
  { slug: 'habit-new', path: '/habits/new', heading: /عادة جديدة/ },
  { slug: 'habit-detail', path: (habit) => `/habits/${habit}`, heading: /./ },
  { slug: 'habit-edit', path: (habit) => `/habits/${habit}/edit`, heading: /./ },
  { slug: 'goals-tree', path: '/goals?view=tree', heading: 'الأهداف' },
  { slug: 'goals-table', path: '/goals?view=table', heading: 'الأهداف' },
  { slug: 'goals-due', path: '/goals?view=due', heading: 'الأهداف' },
  { slug: 'goals-timeline', path: '/goals?view=timeline', heading: 'الأهداف' },
  { slug: 'goals-horizons', path: '/goals?view=horizons', heading: 'الأهداف' },
  { slug: 'goal-detail', path: '/goals/O1', heading: /الصحة الجسدية/ },
  { slug: 'review-week', path: '/review?tab=week', heading: 'المراجعة' },
  { slug: 'review-journal', path: '/review?tab=journal', heading: 'المراجعة' },
  { slug: 'review-mood', path: '/review?tab=mood', heading: 'المراجعة' },
  { slug: 'focus', path: '/focus', heading: 'التركيز' },
  { slug: 'breath', path: '/breath', heading: 'التنفّس' },
  { slug: 'ask', path: '/ask', heading: 'اسأل' },
  { slug: 'settings', path: '/settings', heading: 'الإعدادات' },
];

/** The page has drawn what it will draw: its heading is there and no placeholder is left. */
async function settle(page: Page, heading: string | RegExp): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible();
  await expect(page.locator('main .skeleton')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** The three checks and the screenshot of the page as it is now. */
async function inspect(page: Page, slug: string): Promise<void> {
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, slug);
}

/** The server fails every call but the session's own (pairing and refresh), as a 500 does. */
async function failServer(page: Page): Promise<void> {
  await page.route('**/v1/**', (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/v1/auth/') || pathname.startsWith('/v1/devices/')) return route.fallback();
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"e2e"}' });
  });
}

/** The page is controlled by the service worker, so a navigation while offline is served from it. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.evaluate(() => navigator.serviceWorker.controller !== null)) return;
    await page.reload();
  }
  throw new Error('the service worker never took control of the page');
}

for (const c of CASES) {
  test(`${c.slug}: loaded, server failing, and offline`, async ({ paired: page, context, projectName }) => {
    const path = typeof c.path === 'string' ? c.path : c.path(PROJECT_DATA[projectName].tickCode);

    // As loaded.
    await page.goto(path);
    await settle(page, c.heading);
    await inspect(page, c.slug);

    // The server fails: the page says so and offers a retry, and still passes the three checks.
    await failServer(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.locator('main .skeleton')).toHaveCount(0);
    await inspect(page, `${c.slug}-error`);
    await page.unroute('**/v1/**');

    // Offline: the saved copy of what was loaded above.
    await page.goto(path);
    await settle(page, c.heading);
    await waitForServiceWorker(page);
    await context.setOffline(true);
    try {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.locator('main .skeleton')).toHaveCount(0);
      await inspect(page, `${c.slug}-offline`);
    } finally {
      await context.setOffline(false);
    }
  });
}

test('pair: as loaded, a refused code, and offline', async ({ page, context }) => {
  await page.goto('/pair');
  await settle(page, 'الإقران');
  await inspect(page, 'pair');

  // A refused code, answered by the test itself: a real failed pairing would count against the
  // server's limit of 20 failures in ten minutes, which the suite never touches.
  await page.route('**/v1/devices/pair', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"الكود غير صالح"}' }),
  );
  await page.getByLabel('كود الإقران').fill('XXXXXXXX');
  await page.getByRole('button', { name: 'إقران الجهاز' }).click();
  await expect(page.getByText('الكود غير صالح').first()).toBeVisible();
  await inspect(page, 'pair-error');
  await page.unroute('**/v1/devices/pair');

  await waitForServiceWorker(page);
  await context.setOffline(true);
  try {
    await page.goto('/pair');
    await expect(page.getByText('يحتاج اتصالاً')).toBeVisible();
    await inspect(page, 'pair-offline');
  } finally {
    await context.setOffline(false);
  }
});
