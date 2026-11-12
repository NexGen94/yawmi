import { expect, test } from './fixtures';
import { expectNoSeriousA11y } from './a11y';
import { expectNoHorizontalScroll, shot } from './shots';

// Two tests in a row in one project, each with a device of its own. The session of the first
// (its rotated refresh cookie) must not leak into the second: both must still reach `/` on a
// reload without seeing `/pair` and without a 401 from the refresh.

for (const order of ['first', 'second'] as const) {
  test(`the ${order} device pairs, reloads and stays on the home page`, async ({ paired: page }) => {
    const urls: string[] = [];
    const refresh: number[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) urls.push(new URL(frame.url()).pathname);
    });
    page.on('response', (res) => {
      if (res.url().endsWith('/v1/auth/refresh')) refresh.push(res.status());
    });

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'العادات المستحقة' })).toBeVisible();

    expect(new URL(page.url()).pathname).toBe('/');
    expect(urls).not.toContain('/pair');
    expect(refresh.length, 'the reload refreshed the session once').toBeGreaterThan(0);
    expect(refresh.filter((status) => status !== 200), 'refresh answers other than 200').toEqual([]);

    await expectNoSeriousA11y(page);
    await expectNoHorizontalScroll(page);
    await shot(page, `pairing-${order}-home`);
  });
}
