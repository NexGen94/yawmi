import { expectNoSeriousA11y } from './a11y';
import { expect, PROJECT_DATA, riyadhToday, SYNC_TIMEOUT, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

interface JournalList {
  entries: { day: string; part: string; answers: { planned_minutes?: number | null; priorities?: { title: string }[] } }[];
}

test('the morning journal saves the planned minutes of the project', async ({ paired: page, api, projectName }) => {
  const { plannedMinutes } = PROJECT_DATA[projectName];
  const today = riyadhToday();
  // Different in every run: on a reused database the server holds the values of the last run, so
  // only a marker written now proves that this save reached it.
  const marker = `أولوية ${projectName} ${Date.now()}`;

  // From the home page to the morning card, as a person would.
  await page.getByRole('link', { name: /يومية الصباح/ }).click();
  await expect(page).toHaveURL(/\/day\/morning$/);
  await expect(page.getByRole('heading', { level: 1, name: 'اليوم' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'يومية الصباح' })).toBeVisible();

  await page.getByLabel('الأولوية 1').fill(marker);
  const chip = page
    .getByRole('group', { name: 'الدقائق المقررة' })
    .getByRole('button', { name: String(plannedMinutes), exact: true });
  // A chip is a toggle: a saved morning of an earlier run may have it chosen already.
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'morning-form');

  await page.getByRole('button', { name: 'حفظ الصباح' }).click();

  // The server holds the value of this project once the outbox is sent (a save can be undone for
  // five seconds first).
  await expect
    .poll(
      async () => {
        const { entries } = await api.get<JournalList>(`/v1/journal?from=${today}&to=${today}`);
        const morning = entries.find((e) => e.part === 'morning');
        return { title: morning?.answers.priorities?.[0]?.title, minutes: morning?.answers.planned_minutes };
      },
      { timeout: SYNC_TIMEOUT },
    )
    .toEqual({ title: marker, minutes: plannedMinutes });

  // And the home page says so.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();
  await expect(page.locator('.day-card-status').first()).toContainText(`حُفظت · ${plannedMinutes}`);

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'morning-home');
});
