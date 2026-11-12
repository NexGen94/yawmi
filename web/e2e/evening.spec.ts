import { expectNoSeriousA11y } from './a11y';
import { expect, PROJECT_DATA, riyadhToday, SYNC_TIMEOUT, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

interface MoodList {
  logs: { day: string; score: number }[];
}

test('the evening logs the mood of the project and closes the day', async ({ paired: page, api, projectName }) => {
  const { mood } = PROJECT_DATA[projectName];
  const today = riyadhToday();

  await page.getByRole('link', { name: /إغلاق اليوم/ }).click();
  await expect(page).toHaveURL(/\/day\/evening$/);
  await expect(page.getByRole('heading', { level: 1, name: 'اليوم' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'يومية المساء' })).toBeVisible();

  // The mood scale is one radio group; a step is named by its numeral.
  await page.getByRole('radio', { name: String(mood), exact: true }).check();
  await expect(page.getByRole('radio', { name: String(mood), exact: true })).toBeChecked();

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'evening-form');

  await page.getByRole('button', { name: 'إغلاق اليوم' }).click();

  await expect
    .poll(
      async () => {
        const { logs } = await api.get<MoodList>(`/v1/mood?from=${today}&to=${today}`);
        return logs.find((l) => l.day === today)?.score;
      },
      { timeout: SYNC_TIMEOUT },
    )
    .toBe(mood);

  // The evening card of the home page says the day is closed.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();
  await expect(page.locator('.day-card-status').nth(1)).toHaveText('أُغلق اليوم');

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'evening-home');
});
