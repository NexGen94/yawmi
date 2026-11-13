import { expectNoSeriousA11y } from './a11y';
import { expect, riyadhToday, SYNC_TIMEOUT, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

interface SessionList {
  items: {
    day: string;
    actual_minutes: number | null;
    planned_minutes: number | null;
    focus_rating: number | null;
    next_step: string | null;
  }[];
}

const MINUTE = 60_000;

test('a session starts, survives a reload, runs past its time and ends; the server holds it', async ({
  paired: page,
  api,
  projectName,
}) => {
  const marker = `خطوة ${projectName} ${Date.now()}`;
  const today = riyadhToday();

  // The page's clock is a fake one that keeps time with the real one: the session is run past its
  // planned time by moving it, not by waiting. It must be in place before the page loads.
  await page.clock.install();
  await page.goto('/focus');
  await expect(page.getByRole('heading', { level: 1, name: 'التركيز' })).toBeVisible();

  // The idle surface: the three durations as a preference, the one prominent button.
  await expect(page.getByRole('radiogroup', { name: 'المدة' })).toBeVisible();
  await expect(page.getByText('المدد الثلاث تفضيل، لا قاعدة')).toBeVisible();
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'focus-idle');

  await page.getByRole('button', { name: 'بدء' }).click();
  const timer = page.getByRole('timer');
  await expect(timer).toHaveText(/^2[45]:\d\d$/);

  // A reload during the session: the session is read back from the device, not lost.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'التركيز' })).toBeVisible();
  await expect(timer).toHaveText(/^2[45]:\d\d$/);
  await expect(page.getByRole('button', { name: 'بدء' })).toHaveCount(0);
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'focus-running');

  // Thirty-one minutes later by the page's clock: the counter goes on upwards, past the 25.
  await page.clock.fastForward(31 * MINUTE);
  await expect(timer).toHaveText(/^\+06:\d\d$/);
  await expect(page.getByRole('button', { name: 'تمديد' })).toBeVisible();
  await expect(page.getByRole('img', { name: /نبتة التركيز: المرحلة 4 من 4/ })).toBeVisible();
  await shot(page, 'focus-overflow');

  await page.getByRole('button', { name: 'إنهاء' }).click();
  const rating = page.getByRole('radiogroup', { name: 'تقييم التركيز' });
  await expect(rating).toBeVisible();
  await rating.getByRole('radio', { name: '4', exact: true }).click();
  await page.getByLabel('الخطوة التالية').fill(marker);
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'focus-wrapup');

  await page.getByRole('button', { name: 'حفظ الجلسة' }).click();
  await expect(page.getByText(/حُفظت الجلسة: 31 دقيقة من 25 دقيقة/)).toBeVisible();
  // The outbox sends five seconds after the save (the undo window), by the page's clock.
  await page.clock.fastForward(10_000);

  await expect
    .poll(
      async () => {
        const { items } = await api.get<SessionList>(`/v1/focus/sessions?from=${today}&to=${today}`);
        const mine = items.find((s) => s.next_step === marker);
        return mine && { actual: mine.actual_minutes, planned: mine.planned_minutes, rating: mine.focus_rating };
      },
      { timeout: SYNC_TIMEOUT },
    )
    .toEqual({ actual: 31, planned: 25, rating: 4 });

  // The score and the hours now count it.
  await expect(page.getByRole('region', { name: 'درجة التركيز' })).toContainText(/\d+ (دقيقة|دقائق)/);
  await expect(page.getByRole('img', { name: /توزيع ساعات التركيز: أكثر ساعة تركيزاً/ })).toBeVisible();
  await expectNoSeriousA11y(page);
  await shot(page, 'focus-done');
});

test('a favourite plan opens from the home page and starts with its own minutes', async ({ paired: page, api, projectName }) => {
  const title = `خطة ${projectName} ${Date.now()}`;
  await api.send('POST', '/v1/focus/plans', { title_ar: title, minutes: 50, favorite: true });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();
  const quick = page.getByRole('region', { name: 'وصول سريع' });
  await quick.getByRole('link', { name: `${title} · 50 دقيقة` }).click();

  await expect(page).toHaveURL(/\/focus\?plan=/);
  await expect(page.getByRole('heading', { level: 1, name: 'التركيز' })).toBeVisible();
  await expect(page.getByText(`${title} · 50 دقيقة`).first()).toBeVisible();
  await page.getByRole('button', { name: 'بدء' }).click();
  await expect(page.getByRole('timer')).toHaveText(/^(49|50):\d\d$/);
  await expect(page.getByRole('timer')).toBeVisible();

  // Stopped at once, with nothing recorded: no session reaches the server.
  await page.getByRole('button', { name: 'إنهاء' }).click();
  await page.getByRole('button', { name: 'تجاهل الجلسة' }).click();
  await expect(page.getByRole('button', { name: 'بدء' })).toBeVisible();

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'focus-plan-from-home');
});

test('without a connection the session still starts and ends, and plans say they need one', async ({ paired: page, context }) => {
  await page.goto('/focus');
  await expect(page.getByRole('heading', { level: 1, name: 'التركيز' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'قوالب جاهزة' })).toBeVisible();

  await context.setOffline(true);
  const templates = page.getByRole('group', { name: 'قوالب جاهزة' });
  await expect(templates.getByRole('button').first()).toBeDisabled();
  await expect(page.getByText('يحتاج اتصالاً').first()).toBeVisible();

  await page.getByRole('button', { name: 'بدء' }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  await expectNoSeriousA11y(page);
  await shot(page, 'focus-offline-running');
  await page.getByRole('button', { name: 'إنهاء' }).click();
  await page.getByRole('button', { name: 'تجاهل الجلسة' }).click();
  await expect(page.getByRole('button', { name: 'بدء' })).toBeVisible();
  await context.setOffline(false);
});
