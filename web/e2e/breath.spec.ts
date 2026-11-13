import type { Page } from '@playwright/test';

import { expectNoSeriousA11y } from './a11y';
import { type Api, expect, riyadhToday, SYNC_TIMEOUT, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

interface Session {
  pattern: string;
  breaths_per_min: number | null;
  duration_seconds: number | null;
  completed: boolean;
  feeling: string | null;
}

/** The sessions of today on the server. */
async function sessionsOf(api: Api): Promise<Session[]> {
  const today = riyadhToday();
  const { items } = await api.get<{ items: Session[] }>(`/v1/breath/sessions?from=${today}&to=${today}`);
  return items;
}


/** A fake clock instead of a wait: the page's timers (the tick of the session, the five-second send)
 *  are run by `fastForward`, and the session reads the time from the timestamps, as a tab that slept
 *  would. */
async function openBreath(page: Page): Promise<void> {
  await page.clock.install();
  await page.goto('/breath');
  await expect(page.getByRole('heading', { level: 1, name: 'التنفّس' })).toBeVisible();
}

test('a one-minute session on a fast clock, then «أهدأ», reaches the server inside the limits', async ({ paired: page, api }) => {
  const before = (await sessionsOf(api)).filter((s) => s.feeling === 'calmer' && s.pattern === 'calm').length;
  await openBreath(page);
  await expect(page.getByText('هذا الأسبوع', { exact: true })).toBeVisible();
  await expect(page.getByText(/يُوقَف التمرين عند الدوار/)).toBeVisible();

  await page.getByRole('radio', { name: 'تهدئة' }).click();
  await page.getByRole('radio', { name: '6', exact: true }).click();
  await page.getByRole('slider', { name: 'المدة' }).fill('1');
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'breath-idle');

  await page.getByRole('button', { name: 'بدء', exact: true }).click();
  const bubble = page.getByRole('img', { name: /فقاعة التنفّس/ });
  await expect(bubble).toBeVisible();
  await expect(page.getByText('شهيق 4 ث')).toBeVisible();
  await expectNoSeriousA11y(page);
  await shot(page, 'breath-running');

  await page.clock.fastForward(60_000);
  const group = page.getByRole('group', { name: 'الشعور بعد الجلسة' });
  await expect(group).toBeVisible();
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'breath-checkin');
  await group.getByRole('button', { name: 'أهدأ' }).click();
  await expect(page.getByRole('button', { name: 'بدء', exact: true })).toBeFocused();

  await page.clock.fastForward(6_000); // the five-second send
  await expect
    .poll(async () => (await sessionsOf(api)).filter((s) => s.feeling === 'calmer' && s.pattern === 'calm').length, { timeout: SYNC_TIMEOUT })
    .toBe(before + 1);
  const saved = (await sessionsOf(api)).filter((s) => s.feeling === 'calmer' && s.pattern === 'calm').at(-1);
  expect(saved?.completed).toBe(true);
  expect(saved?.breaths_per_min).toBeGreaterThanOrEqual(5);
  expect(saved?.breaths_per_min).toBeLessThanOrEqual(6.5);
  expect(saved?.duration_seconds).toBe(60);

  // The week now holds the minute.
  await expect(page.locator('.week-minutes')).toContainText('دق');
  await expect(page.getByRole('list', { name: 'جلسات الأسبوع' })).toBeVisible();
  await expectNoSeriousA11y(page);
  await shot(page, 'breath-week');
});

test('the exhale test and the hold test: two taps each, the hold test stopped by its cap at 30', async ({ paired: page, api }) => {
  const count = async (pattern: string): Promise<number> => (await sessionsOf(api)).filter((s) => s.pattern === pattern).length;
  const exhaleBefore = await count('exhale_test');
  const holdBefore = await count('hold_test');
  await openBreath(page);

  await page.getByRole('button', { name: 'بدء الزفير' }).click();
  await page.clock.fastForward(18_000);
  await page.getByRole('button', { name: 'انتهاء الزفير' }).click();
  await expect(page.getByText(/^18 ث · /)).toBeVisible();

  // The hold test is in a disclosure that is closed.
  const details = page.locator('details', { hasText: 'اختبار اختياري' });
  await expect(details).not.toHaveAttribute('open', '');
  await details.getByText('اختبار اختياري').click();
  await expect(page.getByText('يمكن التوقف في أي لحظة')).toBeVisible();
  await page.getByRole('button', { name: 'بدء الحبس' }).click();
  await page.clock.fastForward(45_000); // the tab slept past the cap
  await expect(page.getByText(/^30 ث · .*رقم شخصي$/)).toBeVisible();
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'breath-tests');

  await page.clock.fastForward(6_000);
  await expect.poll(() => count('exhale_test'), { timeout: SYNC_TIMEOUT }).toBe(exhaleBefore + 1);
  await expect.poll(() => count('hold_test'), { timeout: SYNC_TIMEOUT }).toBe(holdBefore + 1);
  const hold = (await sessionsOf(api)).filter((s) => s.pattern === 'hold_test').at(-1);
  expect(hold?.duration_seconds).toBe(30);
  const exhale = (await sessionsOf(api)).filter((s) => s.pattern === 'exhale_test').at(-1);
  expect(exhale?.duration_seconds).toBe(18);
});

test('with reduced motion the phase is words and the bubble stays still', async ({ paired: page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openBreath(page);
  await page.getByRole('radio', { name: 'تهدئة' }).click();
  await page.getByRole('radio', { name: '6', exact: true }).click();
  await page.getByRole('button', { name: 'بدء', exact: true }).click();
  const bubble = page.getByRole('img', { name: /فقاعة التنفّس/ });
  await expect(bubble).toHaveAttribute('data-motion', 'reduced');
  await expect(page.getByText('شهيق 4 ث')).toBeVisible();
  const duration = await bubble.locator('.bubble-core').evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(duration).toBe('0s');
  await page.clock.fastForward(4_500);
  await expect(page.getByText('زفير 6 ث')).toBeVisible();
  await page.getByRole('button', { name: 'إنهاء' }).click();
  await page.getByRole('button', { name: 'تجاوز' }).click();
  await expectNoSeriousA11y(page);
});

test('the weekly target set in the settings brings the ring to the breathing page', async ({ paired: page }) => {
  // The saved choices arrive after the first paint and recolour a segment: without motion there is no
  // transition for the contrast check to catch half-way.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'الأهداف الرقمية' });
  await expect(section).toBeVisible();
  const field = section.getByLabel('هدف دقائق التنفّس الأسبوعي');
  // The server keeps the last run's number: take one that is different, so that there is a change to save.
  const target = (await field.inputValue()) === '30' ? '31' : '30';
  await field.fill(target);
  await expectNoSeriousA11y(page);
  await shot(page, 'settings-targets');
  await section.getByRole('button', { name: 'حفظ الأهداف' }).click();
  await expect(section.getByText('تم الحفظ')).toBeVisible();

  await page.goto('/breath');
  await expect(page.getByRole('heading', { level: 1, name: 'التنفّس' })).toBeVisible();
  await expect(page.getByRole('img', { name: /دقائق التنفّس هذا الأسبوع/ })).toBeVisible();
  await expect(page.locator('.week-minutes')).toContainText(`من ${target}`);
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'breath-ring');
});
