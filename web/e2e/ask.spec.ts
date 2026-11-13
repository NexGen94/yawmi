import { expectNoSeriousA11y } from './a11y';
import { expect, riyadhToday, SYNC_TIMEOUT, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

// The first web consumer of the server AI, against the fake provider of the test server (no
// network, no key). Each test starts from a withdrawn consent so the dialog is always seen, and
// leaves the memory empty and the consent withdrawn for the tests after it.

const QUESTION = 'ما حالة أهدافي هذا الأسبوع؟';
const FAKE_LINES = ['ملخص تجريبي لليوم.', 'هذا رد ثابت من مزوّد وهمي للاختبار.'];

interface MemoryList {
  items: { kind: string; text: string }[];
}

test('the ask panel: shortcut or button, the consent dialog, then the answer of the provider', async ({
  paired: page,
  api,
  projectName,
}) => {
  await api.send('DELETE', '/v1/ai/consent');
  await api.send('DELETE', '/v1/ai/memory');

  // What the app sends to /v1/ask: the question and the range, never a context or sources. The body
  // is read where the app hands it to fetch (it is a stream by then, which the network log of the
  // browser does not keep).
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __askBodies: string[] }).__askBodies = seen;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'POST' && new URL(request.url).pathname === '/v1/ask') seen.push(await request.clone().text());
      return original(input, init);
    };
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();

  // The shortcut on the desktop; the header button on the phone (it has no keyboard).
  if (projectName === 'desktop') await page.keyboard.press('Control+K');
  else await page.getByRole('button', { name: 'اسأل' }).click();
  const panel = page.getByRole('dialog', { name: 'اسأل' });
  await expect(panel).toBeVisible();
  const field = panel.getByLabel('السؤال');
  await expect(field).toBeFocused();
  await expect(panel.getByRole('radio', { name: '7 أيام' })).toBeChecked();

  await field.fill(QUESTION);
  await panel.getByRole('button', { name: 'سؤال', exact: true }).click();

  // No consent yet: the dialog names the provider and keeps the personal-text key off.
  const consent = page.getByRole('dialog', { name: /Anthropic/ });
  await expect(consent).toBeVisible();
  await expect(consent.getByRole('checkbox', { name: /رسالتي/ })).not.toBeChecked();
  await expectNoSeriousA11y(page);
  await shot(page, 'ask-consent');
  await consent.getByRole('button', { name: 'موافقة' }).click();

  // The answer of the fake provider, with the cards of the sources and the days.
  await expect(panel.getByText(FAKE_LINES[0] as string)).toBeVisible();
  await expect(panel.getByText(FAKE_LINES[1] as string)).toBeVisible();
  await expect(panel.getByText(/^من أيام:/).or(panel.getByRole('list', { name: 'مصادر الجواب' })).first()).toBeVisible();
  const bodies = (await page.evaluate(() => (window as unknown as { __askBodies: string[] }).__askBodies)).map(
    (text) => JSON.parse(text) as object,
  );
  // the first try (refused for want of a consent) and the one after «موافقة»
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body).toEqual({ question: QUESTION, range: '7d' });
    expect(Object.keys(body as object)).not.toContain('context');
    expect(Object.keys(body as object)).not.toContain('sources');
  }

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'ask-answer');

  // «حفظ في الذاكرة» keeps the answer as a note that goes with later requests.
  await panel.getByRole('button', { name: 'حفظ في الذاكرة' }).click();
  await expect(panel.getByText('حُفظ في الذاكرة')).toBeVisible();
  await expect
    .poll(async () => (await api.get<MemoryList>('/v1/ai/memory')).items.map((i) => i.kind), { timeout: SYNC_TIMEOUT })
    .toEqual(['note']);

  // Escape closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await api.send('DELETE', '/v1/ai/memory');
  await api.send('DELETE', '/v1/ai/consent');
});

test('closing the day with the consent in place shows the summary of the provider', async ({ paired: page, api }) => {
  await api.send('PUT', '/v1/ai/consent', { provider: 'anthropic', personal_text: false });
  await page.goto('/day/evening');
  await expect(page.getByRole('heading', { name: 'يومية المساء' })).toBeVisible();

  await page.getByRole('button', { name: 'إغلاق اليوم' }).click();

  const summary = page.getByRole('region', { name: 'ملخص اليوم من الذكاء' });
  await expect(summary.getByText(FAKE_LINES[0] as string)).toBeVisible({ timeout: SYNC_TIMEOUT });
  await expect(summary.getByText(FAKE_LINES[1] as string)).toBeVisible();
  // The journal of the day reached the server before the summary was asked for.
  const today = riyadhToday();
  const { entries } = await api.get<{ entries: { part: string }[] }>(`/v1/journal?from=${today}&to=${today}`);
  expect(entries.some((e) => e.part === 'evening')).toBe(true);

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'evening-summary');
  await api.send('DELETE', '/v1/ai/consent');
});

test('taking the closing back within its window sends nothing and asks for no summary', async ({ paired: page, api }) => {
  await api.send('PUT', '/v1/ai/consent', { provider: 'anthropic', personal_text: false });
  const closes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/day/close') closes.push(request.method());
  });
  await page.goto('/day/evening');
  await expect(page.getByRole('heading', { name: 'يومية المساء' })).toBeVisible();
  // Different in every run: only this closing could put it on the server.
  const marker = `إنجاز تراجع ${Date.now()}`;
  await page.getByLabel('إنجاز اليوم').fill(marker);
  await page.getByRole('button', { name: 'إغلاق اليوم' }).click();
  await expect(page.getByText('جارٍ الحفظ')).toBeVisible();
  await page.getByRole('button', { name: 'تراجع' }).click();
  await expect(page.getByText('أُلغي الحفظ')).toBeVisible();
  // Past the window (five seconds): nothing went out and no summary was asked for.
  await page.waitForTimeout(7000);
  expect(closes).toEqual([]);
  const today = riyadhToday();
  const { entries } = await api.get<{ entries: { part: string; answers: { win?: string | null } }[] }>(`/v1/journal?from=${today}&to=${today}`);
  expect(entries.some((e) => e.answers.win === marker)).toBe(false);
  await api.send('DELETE', '/v1/ai/consent');
});

test('the AI settings: consent, style, a lens and the visible memory', async ({ paired: page, api }) => {
  await api.send('DELETE', '/v1/ai/memory');
  await api.send('PUT', '/v1/ai/consent', { provider: 'anthropic', personal_text: false });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible();

  const ai = page.getByRole('region', { name: 'الذكاء الاصطناعي' });
  await expect(ai.getByRole('button', { name: 'سحب الموافقة' })).toBeVisible();

  // A lens: written, listed, and part of what goes with every request.
  await page.getByLabel('عدسة جديدة').fill('ركّز على الأسبوع لا اليوم');
  await page.getByRole('button', { name: 'إضافة عدسة' }).click();
  const lenses = page.getByRole('list', { name: 'العدسات' });
  await expect(lenses.getByText('ركّز على الأسبوع لا اليوم')).toBeVisible();
  await expect(page.getByRole('region', { name: 'الذاكرة' }).getByText('ما يُرفق بكل طلب')).toBeVisible();

  // The style is saved at once.
  await page.getByRole('radio', { name: 'سطر واحد' }).click();
  await expect(page.getByRole('region', { name: 'أسلوب الرد' }).getByText('تم الحفظ')).toBeVisible();
  await page.getByRole('radio', { name: 'سطران' }).click();
  await expect(page.getByRole('radio', { name: 'سطران' })).toBeChecked();

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'settings-ai');

  // The full reset asks first.
  await page.getByRole('button', { name: 'إعادة ضبط كاملة' }).click();
  await page.getByRole('dialog', { name: 'إعادة ضبط الذاكرة' }).getByRole('button', { name: 'حذف كل البنود' }).click();
  await expect(lenses).toBeHidden();
  expect((await api.get<MemoryList>('/v1/ai/memory')).items).toEqual([]);

  await api.send('DELETE', '/v1/ai/consent');
});
