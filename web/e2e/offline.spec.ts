import type { Page } from '@playwright/test';

import { expectNoSeriousA11y } from './a11y';
import { expect, PROJECT_DATA, riyadhToday, SYNC_TIMEOUT, test, type Api } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

interface HabitLogs {
  logs: { habit_code: string; day: string; value: number | null; status: string }[];
}

/** The habit's log of today on the server, if there is one. */
async function logOf(api: Api, code: string): Promise<HabitLogs['logs'][number] | undefined> {
  const today = riyadhToday();
  const { logs } = await api.get<HabitLogs>(`/v1/habit-logs?from=${today}&to=${today}&code=${code}`);
  return logs.find((l) => l.habit_code === code && l.day === today);
}

/** The first number of «n من m» in the ring card: the habits done today. */
async function doneCount(page: Page): Promise<number> {
  const text = (await page.locator('.hero-count').innerText()).trim();
  const done = /^\d+/.exec(text);
  expect(done, `the count line «${text}»`).not.toBeNull();
  return Number((done as RegExpExecArray)[0]);
}

/** The page is controlled by the service worker, so a reload while offline is served from it. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.evaluate(() => navigator.serviceWorker.controller !== null)) return;
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();
  }
  throw new Error('the service worker never took control of the page');
}

test('without a connection a tick and two quick adds are kept, shown after a reload, and sent when the connection returns', async ({
  paired: page,
  context,
  api,
  projectName,
}) => {
  const { tickCode, minutesCode } = PROJECT_DATA[projectName];
  const tickRow = page.locator(`li[data-code="${tickCode}"]`);
  const minutesRow = page.locator(`li[data-code="${minutesCode}"]`);
  await expect(tickRow).toBeVisible();
  await expect(minutesRow).toBeVisible();

  // An earlier run on this server may have ticked the habit already. A sent tick is corrected by a
  // skip (the row says so); wait for the server to hold it, so that the tick below is a new one.
  if ((await tickRow.locator('.check-row').getAttribute('aria-pressed')) === 'true') {
    await tickRow.getByRole('button', { name: /^تخطي/ }).click();
    await expect.poll(async () => (await logOf(api, tickCode))?.status, { timeout: SYNC_TIMEOUT }).toBe('skip');
    await expect(tickRow.locator('.check-row')).toHaveAttribute('aria-pressed', 'false');
  }
  const firstValue = (await logOf(api, minutesCode))?.value ?? 0;

  await waitForServiceWorker(page);
  await expect(tickRow).toBeVisible();
  const doneBefore = await doneCount(page);

  await context.setOffline(true);
  await expect(page.locator('.connection')).toHaveAttribute('data-state', 'offline');

  // One tick, then «+5» twice: the second adds to the first, 10 in all.
  await tickRow.locator('.check-row').click();
  await expect(tickRow.locator('.check-row')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => doneCount(page)).toBe(doneBefore + 1);
  const plusFive = minutesRow.getByRole('button', { name: /^\+5/ });
  await plusFive.click();
  await plusFive.click();
  await expect(minutesRow.locator('.check-note')).toContainText(`${firstValue + 10} من`);

  // A reload offline is served by the service worker: the saved copy, with the records kept.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();
  await expect(page.getByText('نسخة محفوظة · بلا اتصال')).toBeVisible();
  await expect(tickRow.locator('.check-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(minutesRow.locator('.check-note')).toContainText(`${firstValue + 10} من`);
  await expect.poll(() => doneCount(page)).toBe(doneBefore + 1);

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'offline-home');

  // The connection returns: the outbox is sent, and the server holds what was done offline.
  await context.setOffline(false);
  await expect
    .poll(async () => (await logOf(api, tickCode))?.status, { timeout: SYNC_TIMEOUT })
    .toBe('done');
  await expect
    .poll(async () => (await logOf(api, minutesCode))?.value, { timeout: SYNC_TIMEOUT })
    .toBe(firstValue + 10);

  await expect(page.locator('.connection')).toHaveAttribute('data-state', 'online');
  // The page asks the server again by itself when the connection returns: no reload.
  await expect(page.getByText('نسخة محفوظة · بلا اتصال')).toBeHidden();
  await expect(tickRow.locator('.check-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(minutesRow.locator('.check-note')).toContainText(`${firstValue + 10} من`);
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'offline-synced');
});
