import { expectNoSeriousA11y } from './a11y';
import { expect, riyadhToday, SYNC_TIMEOUT, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

interface StoredHabit {
  code: string;
  title_ar: string;
  kind: string;
  unit: string;
  period: string;
  target_per_period: number;
  start_day: string;
  end_day: string | null;
  identity_text: string | null;
  goal_ref: string | null;
  outcome: string | null;
}

/** `day` plus `n` calendar days, as an ISO day (UTC arithmetic: no zone moves it). */
function plusDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

test('a daily reading habit of 20 minutes for 30 days is created and listed under «فعّالة»', async ({
  paired: page,
  api,
  projectName,
}) => {
  const today = riyadhToday();
  // Different in every run: the two projects and every run share one database, and only this
  // title proves the habit below is the one this test made.
  const title = `قراءة 20 دقيقة ${projectName} ${Date.now()}`;

  // From the habits page, as a person would.
  await page.goto('/habits');
  await expect(page.getByRole('heading', { level: 1, name: 'العادات' })).toBeVisible();
  await page.getByRole('link', { name: 'عادة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/habits\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: 'عادة جديدة' })).toBeVisible();

  await page.getByLabel('العنوان').fill(title);
  await page.getByRole('radiogroup', { name: 'النوع' }).getByRole('radio', { name: 'مدة' }).click();
  await page.getByLabel('الهدف في الفترة').fill('20');
  await page.getByRole('radiogroup', { name: 'طول الفترة' }).getByRole('radio', { name: '30 يوماً' }).click();

  // «إلى» follows the chip, and the summary says the same.
  const end = plusDays(today, 29);
  await expect(page.getByLabel('إلى')).toHaveValue(end);
  const summary = page.getByRole('region', { name: 'ملخص العادة' });
  await expect(summary).toContainText('المطلوب يومياً: 20 دقيقة');
  await expect(summary).toContainText('المدة: 30 يوماً');

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'habit-editor');

  await page.getByRole('button', { name: 'حفظ العادة' }).click();

  // The save lands on the habit's own page.
  await expect(page).toHaveURL(/\/habits\/u_[0-9a-f]+$/);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

  // The server holds it, with its end 29 days after its start.
  const habits = await api.get<StoredHabit[]>('/v1/habits');
  const stored = habits.find((h) => h.title_ar === title);
  expect(stored, 'the habit is on the server').toBeDefined();
  expect(stored).toMatchObject({ kind: 'duration', unit: 'min', period: 'day', target_per_period: 20, start_day: today });
  expect(stored?.end_day).toBe(plusDays(stored?.start_day ?? today, 29));

  // And the habits list shows it under «فعّالة».
  await page.goto('/habits');
  await expect(page.getByRole('heading', { level: 1, name: 'العادات' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^فعّالة/ })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => page.getByText(title).count(), { timeout: SYNC_TIMEOUT }).toBeGreaterThan(0);
  await expect(page.getByText(title).first()).toBeVisible();

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'habit-list-after-new');
});

test('the editor is reachable by keyboard alone', async ({ paired: page }) => {
  await page.goto('/habits/new');
  await expect(page.getByRole('heading', { level: 1, name: 'عادة جديدة' })).toBeVisible();
  await page.getByLabel('العنوان').focus();
  await page.keyboard.type('مشي');
  // Tab to the type group and choose «عدد» with the arrow key, as a radio group asks.
  await page.keyboard.press('Tab');
  const types = page.getByRole('radiogroup', { name: 'النوع' });
  await expect(types.getByRole('radio', { name: 'نعم أو لا' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(types.getByRole('radio', { name: 'عدد' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radiogroup', { name: 'الوحدة' })).toBeVisible();
});

test('a habit made from a goal keeps its link to the goal', async ({ paired: page, api, projectName }) => {
  const title = `عادة من هدف ${projectName} ${Date.now()}`;
  await page.goto('/habits/new');
  await expect(page.getByRole('heading', { level: 1, name: 'عادة جديدة' })).toBeVisible();

  await page.getByRole('radiogroup', { name: 'المصدر' }).getByRole('radio', { name: 'من هدف' }).click();
  const goals = page.getByRole('list', { name: 'الأهداف' });
  await expect(goals).toBeVisible();
  await goals.getByRole('button').first().click();
  // The draft fills the title from the goal; the test then names the habit in its own way.
  await expect(page.getByLabel('العنوان')).not.toHaveValue('');
  await expect(page.getByRole('region', { name: 'ملخص العادة' })).toContainText('يخدم المخرج');
  await page.getByLabel('العنوان').fill(title);

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'habit-editor-from-goal');

  await page.getByRole('button', { name: 'حفظ العادة' }).click();
  await expect(page).toHaveURL(/\/habits\/u_[0-9a-f]+$/);

  const habits = await api.get<StoredHabit[]>('/v1/habits');
  const stored = habits.find((h) => h.title_ar === title);
  expect(stored?.goal_ref, 'linked to the milestone or card').toBeTruthy();
  expect(stored?.outcome).toMatch(/^O\d+$/);
});
