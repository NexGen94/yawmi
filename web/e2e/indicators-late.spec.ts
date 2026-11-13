import { expectNoSeriousA11y } from './a11y';
import { expect, riyadhToday, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

interface StoredIndicator {
  subject_kind: string;
  subject_ref: string;
  measure: string;
  target: number | null;
  display: string;
}

interface StoredHabit {
  code: string;
  reminders: { time: string; days_mask: number }[];
}

/** `day` plus `n` calendar days, as an ISO day (UTC arithmetic: no zone moves it). */
function plusDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

test('the indicator of a habit is customised, gets a reminder, and goes back to its default', async ({
  paired: page,
  api,
  projectName,
}) => {
  const code = `e2e_tick_${projectName}`;
  await page.goto(`/habits/${code}`);
  const card = page.getByRole('region', { name: 'المؤشر' });
  await expect(card).toBeVisible();
  await expectNoSeriousA11y(page);
  await shot(page, 'habit-indicator');

  // What is measured: the total, against a target, as a bar.
  await card.getByRole('button', { name: 'تخصيص وإضافة تذكير' }).click();
  const dialog = page.getByRole('dialog', { name: 'تخصيص المؤشر' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radiogroup', { name: 'القياس' }).getByRole('radio')).toHaveCount(5);
  await dialog.getByRole('radio', { name: 'المجموع' }).click();
  await dialog.getByRole('radio', { name: 'شريط' }).click();
  await dialog.getByLabel('المستهدف').fill('30');
  await expectNoSeriousA11y(page);
  await shot(page, 'indicator-dialog');
  await dialog.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(dialog).toBeHidden();

  const saved = await api.get<{ items: StoredIndicator[] }>('/v1/indicators');
  expect(saved.items.find((i) => i.subject_ref === code)).toMatchObject({
    subject_kind: 'habit',
    measure: 'total',
    target: 30,
    display: 'bar',
  });
  await expect(card.getByRole('img', { name: /مؤشر/ })).toBeVisible();

  // A reminder, from the same card: it is the habit's own, not the indicator's.
  await card.getByRole('button', { name: 'تخصيص وإضافة تذكير' }).click();
  await dialog.getByLabel('وقت التذكير الجديد').fill('20:00');
  await dialog.getByRole('button', { name: 'إضافة تذكير', exact: true }).click();
  await expect(dialog.getByText('تم الحفظ')).toBeVisible();
  const habits = await api.get<StoredHabit[]>('/v1/habits');
  expect(habits.find((h) => h.code === code)?.reminders).toContainEqual({ time: '20:00', days_mask: 127 });

  // And back to the default.
  await dialog.getByRole('button', { name: 'إعادة إلى الافتراض' }).click();
  await expect(dialog).toBeHidden();
  const reset = await api.get<{ items: StoredIndicator[] }>('/v1/indicators');
  expect(reset.items.find((i) => i.subject_ref === code)).toBeUndefined();
  await expectNoHorizontalScroll(page);
});

test('the indicator card is on the page of a goal, with its dialog', async ({ paired: page }) => {
  await page.goto('/goals/O1');
  await expect(page.getByRole('heading', { level: 1, name: /الصحة الجسدية/ })).toBeVisible();
  const card = page.getByRole('region', { name: 'المؤشر' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'تخصيص وإضافة تذكير' }).click();
  const dialog = page.getByRole('dialog', { name: 'تخصيص المؤشر' });
  await expect(dialog.getByRole('radiogroup', { name: 'المصدر' }).getByRole('radio')).toHaveCount(3);
  await expectNoSeriousA11y(page);
  await shot(page, 'goal-indicator-dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

// The milestone of the card «بطاقة النظام» is due in 30 days: the test brings it a day or two into
// the past, and the home page lists it as late with its sentence.
const MILESTONE = 'e2e-ms-5';
const DAYS_LATE = { desktop: 1, mobile: 2 } as const;

test('a milestone past its day is listed as late on the home page with its impact sentence', async ({
  paired: page,
  projectName,
}) => {
  const late = DAYS_LATE[projectName];
  const day = plusDays(riyadhToday(), -late);

  await page.goto('/goals/O3');
  const row = page.locator(`[data-milestone="${MILESTONE}"]`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^تعديل الموعد/ }).click();
  await row.getByLabel('الموعد').fill(day);
  await row.getByRole('button', { name: 'حفظ' }).click();
  await expect(row.getByText('معلّق')).toBeVisible();

  await page.goto('/');
  const section = page.getByRole('region', { name: 'المتأخر وغير المنجز' });
  const item = section.getByRole('listitem').filter({ hasText: 'نسخة احتياطية أولى' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('متأخر');
  await expect(item).toContainText(`${late === 1 ? 'يوماً واحداً' : 'يومين'} عن موعدها ${day}`);
  await expect(item.getByRole('link')).toHaveAttribute('href', `/goals/${MILESTONE}`);

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'home-late');
});

test('رسالتي and رؤيتي are written in the settings and shown on the home page exactly as saved', async ({
  paired: page,
  api,
  projectName,
}) => {
  const mission = `رسالة ${projectName}:\nخطوات صغيرة، كل يوم.`;
  const vision = `رؤية ${projectName} حتى 2031`;

  await page.goto('/');
  const card = page.getByRole('region', { name: 'رسالتي ورؤيتي' });
  await expect(card).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible();
  await page.getByLabel('رسالتي', { exact: true }).fill(mission);
  await page.getByLabel('رؤيتي', { exact: true }).fill(vision);
  await expectNoSeriousA11y(page);
  await shot(page, 'settings-profile');
  await page.getByRole('button', { name: 'حفظ رسالتي ورؤيتي' }).click();
  await expect(page.getByText('تم الحفظ').first()).toBeVisible();

  const settings = await api.get<{ mission: string; vision: string; late_notice_enabled: boolean; late_notice_time: string }>('/v1/settings');
  expect(settings).toMatchObject({ mission, vision, late_notice_enabled: true, late_notice_time: '20:00' });

  await page.goto('/');
  const again = page.getByRole('region', { name: 'رسالتي ورؤيتي' });
  // the person's own words, newline and all
  await expect(again.locator('.mission-text').first()).toHaveText(mission);
  await expect(again).toContainText(vision);
  await expect(again.getByRole('link', { name: 'كتابتهما من الإعدادات' })).toHaveCount(0);
  await expectNoSeriousA11y(page);
  await shot(page, 'home-mission');
});
