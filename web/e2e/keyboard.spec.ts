import type { Locator, Page } from '@playwright/test';

import { expectNoSeriousA11y } from './a11y';
import { expect, newPairCode, PROJECT_DATA, riyadhToday, sharedStateTest as test, SYNC_TIMEOUT } from './fixtures';

// One whole path with the keyboard and nothing else (Task 24, step 5): pairing, a tick, the evening
// journal, then a question. No click, no mouse: every control is reached with Tab (so each one is in
// the tab order and shows where it is) and used with Enter, Space or the arrow keys. The second test
// is the Arabic layout: K types «ن» and / types «ظ», and the shortcuts go by the physical key.

const QUESTION = 'ما حالة أهدافي هذا الأسبوع؟';
const FAKE_LINE = 'هذا رد ثابت من مزوّد وهمي للاختبار.';

interface JournalList {
  entries: { part: string; answers: { win?: string | null } }[];
}

/** Presses Tab until `target` has the focus, and says where the focus went on the way. */
async function tabTo(page: Page, target: Locator, max = 120): Promise<void> {
  await expect(target).toBeVisible();
  for (let step = 0; step < max; step += 1) {
    // Asked of the locator each time: a page that draws again swaps the element under a held handle.
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached the control within ${max} presses`);
}

/** The ring of the focus is drawn: the focused control has an outline or a shadow of the ring. */
async function expectFocusRing(page: Page): Promise<void> {
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const style = getComputedStyle(el);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(ring, 'the focused control shows a ring').not.toBeNull();
  expect(ring?.shadow !== 'none' || ring?.outline !== 'none', JSON.stringify(ring)).toBe(true);
}

test('pairing, a tick, the evening journal and a question, with the keyboard alone', async ({
  page,
  request,
  api,
  projectName,
}) => {
  const { minutesCode, mood } = PROJECT_DATA[projectName];
  const today = riyadhToday();
  const marker = `لوحة المفاتيح ${projectName} ${Date.now()}`;
  await api.send('DELETE', '/v1/ai/consent');
  await api.send('DELETE', '/v1/ai/memory');

  // ---- pairing: Tab to the field, type the code, Enter ----
  const code = await newPairCode(request);
  await page.goto('/pair');
  const field = page.getByLabel('كود الإقران');
  await tabTo(page, field);
  await expectFocusRing(page);
  await page.keyboard.type(code);
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();

  // ---- a quick add on a minutes habit: Tab to «+5», Enter ----
  const row = page.locator(`li[data-code="${minutesCode}"]`);
  await expect(row).toBeVisible();
  const read = async (): Promise<number> => Number(/^\D*(\d+)/.exec((await row.locator('.check-note').innerText()).trim())?.[1] ?? 0);
  const before = await read();
  const plusFive = row.getByRole('button', { name: /^\+5/ });
  await tabTo(page, plusFive);
  await expectFocusRing(page);
  await page.keyboard.press('Enter');
  await expect.poll(read).toBe(before + 5);

  // ---- the evening: the link «إغلاق اليوم», the mood with the arrow keys, the words, close ----
  const toEvening = page.getByRole('link', { name: /إغلاق اليوم/ });
  await tabTo(page, toEvening);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/day\/evening$/);
  await expect(page.getByRole('heading', { name: 'يومية المساء' })).toBeVisible();
  // A day that is already closed opens as a summary: «تعديل الإغلاق» opens the form, by keyboard too.
  const reopen = page.getByRole('button', { name: 'تعديل الإغلاق' });
  if (await reopen.isVisible()) {
    await tabTo(page, reopen);
    await page.keyboard.press('Enter');
  }

  // The mood group is one tab stop (the chosen step, or the first when none is); the arrows move
  // inside it.
  const first = page.getByRole('radiogroup', { name: 'المزاج' }).locator('[role="radio"][tabindex="0"]');
  await tabTo(page, first);
  const wanted = page.getByRole('radio', { name: String(mood), exact: true });
  for (const arrow of ['ArrowLeft', 'ArrowRight']) {
    for (let press = 0; press < 5 && !(await wanted.isChecked()); press += 1) await page.keyboard.press(arrow);
  }
  await expect(wanted).toBeChecked();

  await tabTo(page, page.getByLabel('إنجاز اليوم'));
  await page.keyboard.type(marker);
  await tabTo(page, page.getByRole('button', { name: 'إغلاق اليوم' }));
  await expectFocusRing(page);
  await expectNoSeriousA11y(page);
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () => (await api.get<JournalList>(`/v1/journal?from=${today}&to=${today}`)).entries.find((e) => e.part === 'evening')?.answers.win,
      { timeout: SYNC_TIMEOUT },
    )
    .toBe(marker);

  // ---- a question: Ctrl+K, type, Tab to «سؤال», Enter, then the consent with Enter on «موافقة» ----
  await page.keyboard.press('Control+KeyK');
  const panel = page.getByRole('dialog', { name: 'اسأل' });
  await expect(panel).toBeVisible();
  const question = panel.getByLabel('السؤال');
  await expect(question).toBeFocused();
  await page.keyboard.type(QUESTION);
  await tabTo(page, panel.getByRole('button', { name: 'سؤال', exact: true }));
  await page.keyboard.press('Enter');
  const consent = page.getByRole('dialog', { name: /Anthropic/ });
  await expect(consent).toBeVisible();
  await tabTo(page, consent.getByRole('button', { name: 'موافقة' }));
  await expectFocusRing(page);
  await page.keyboard.press('Enter');
  await expect(panel.getByText(FAKE_LINE)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await api.send('DELETE', '/v1/ai/memory');
  await api.send('DELETE', '/v1/ai/consent');
});

test('on the Arabic layout Ctrl+K and / open «اسأل», and Escape closes it', async ({ paired: page }) => {
  // The keys of the Arabic layout: the physical key is the same, the character is not. Playwright
  // sends the characters of the US layout, so the events of the Arabic one are made here.
  const press = (code: string, key: string, ctrlKey: boolean): Promise<void> =>
    page.evaluate(
      ({ code, key, ctrlKey }) => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { code, key, ctrlKey, bubbles: true, cancelable: true }));
      },
      { code, key, ctrlKey },
    );
  const panel = page.getByRole('dialog', { name: 'اسأل' });

  await press('KeyK', 'ن', true);
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('السؤال')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await press('Slash', 'ظ', false);
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // Inside a field the slash is text, not the shortcut; Ctrl+K still works there.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible();
  const input = page.locator('input[type="text"], textarea').first();
  await input.focus();
  await press('Slash', 'ظ', false);
  await expect(panel).toBeHidden();
  await press('KeyK', 'ن', true);
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
});
