import { expectNoSeriousA11y } from './a11y';
import { expect, openEveningForm, riyadhToday, sharedStateTest as test, SYNC_TIMEOUT } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

// The first web consumer of the server AI, against the fake provider of the test server (no
// network, no key). Each test starts from a withdrawn consent so the dialog is always seen, and
// leaves the memory empty and the consent withdrawn for the tests after it. The consent is the
// user's, not a device's: `sharedStateTest` makes the tests of this file (and of review.spec) take
// turns when the suite runs with more than one worker.

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

  // What the app sends to /v1/ask, with the status it got: the question and the range, never a
  // context or sources. The body is read where the app hands it to fetch (it is a stream by then,
  // which the network log of the browser does not keep).
  //
  // After the reload the in-memory token is gone, and the first request waits on the cookie refresh.
  // On a slow machine /v1/ask goes out before the refresh is done: the server answers 401 and
  // `authedFetch` sends the same request again once the token is there (F-066). That 401 never
  // reaches the consent check or the provider, so it is not an ask: only answers other than 401 count.
  await page.addInitScript(() => {
    const seen: { body: string; status: number }[] = [];
    (window as unknown as { __asks: typeof seen }).__asks = seen;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const isAsk = request.method === 'POST' && new URL(request.url).pathname === '/v1/ask';
      const body = isAsk ? await request.clone().text() : '';
      const response = await original(input, init);
      if (isAsk) seen.push({ body, status: response.status });
      return response;
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
  const asks = await page.evaluate(() => (window as unknown as { __asks: { body: string; status: number }[] }).__asks);
  const answered = asks.filter((ask) => ask.status !== 401);
  // The first try is refused for want of a consent (403); after «موافقة» exactly one request goes
  // out and the provider answers it (200): the provider is asked once.
  expect(answered.map((ask) => ask.status)).toEqual([403, 200]);
  for (const ask of asks) {
    const body = JSON.parse(ask.body) as object;
    expect(body).toEqual({ question: QUESTION, range: '7d' });
    expect(Object.keys(body)).not.toContain('context');
    expect(Object.keys(body)).not.toContain('sources');
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

test('a slow refresh after the reload: the 401 is sent again by the app, and the provider is still asked once', async ({
  paired: page,
  api,
  projectName,
}) => {
  await api.send('DELETE', '/v1/ai/consent');
  await page.addInitScript(() => {
    const seen: number[] = [];
    (window as unknown as { __statuses: number[] }).__statuses = seen;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await original(input, init);
      if (request.method === 'POST' && new URL(request.url).pathname === '/v1/ask') seen.push(response.status);
      return response;
    };
  });
  // The cookie refresh after the reload takes 1.5 s: /v1/ask goes out without a token, the server
  // answers 401, and `authedFetch` sends it again when the token is there (F-066).
  await page.route('**/v1/auth/refresh', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'الرئيسية' })).toBeVisible();
  if (projectName === 'desktop') await page.keyboard.press('Control+K');
  else await page.getByRole('button', { name: 'اسأل' }).click();
  const panel = page.getByRole('dialog', { name: 'اسأل' });
  await panel.getByLabel('السؤال').fill(QUESTION);
  await panel.getByRole('button', { name: 'سؤال', exact: true }).click();
  await page.getByRole('dialog', { name: /Anthropic/ }).getByRole('button', { name: 'موافقة' }).click();
  await expect(panel.getByText(FAKE_LINES[0] as string)).toBeVisible();
  const statuses = await page.evaluate(() => (window as unknown as { __statuses: number[] }).__statuses);
  // the unauthenticated try, the one refused for want of a consent, the one the provider answered
  expect(statuses).toEqual([401, 403, 200]);
  await api.send('DELETE', '/v1/ai/memory');
  await api.send('DELETE', '/v1/ai/consent');
});

test('closing the day with the consent in place shows the summary of the provider', async ({ paired: page, api }) => {
  await api.send('PUT', '/v1/ai/consent', { provider: 'anthropic', personal_text: false });
  await page.goto('/day/evening');
  await openEveningForm(page);
  await expect(page.getByRole('heading', { name: 'يومية المساء' })).toBeVisible();

  // The day may already hold a summary (the other project closed it): the region then shows that one
  // until this closing replaces it with «جارٍ الحفظ». So the lines are read only after this closing
  // has run its course: the window of «تراجع» (five seconds), the events, then the summary request.
  const eventsSent = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/events' && r.request().method() === 'POST',
    { timeout: SYNC_TIMEOUT },
  );
  const summaryAsked = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/day/close' && r.request().method() === 'POST',
    { timeout: SYNC_TIMEOUT },
  );
  await page.getByRole('button', { name: 'إغلاق اليوم' }).click();
  expect((await eventsSent).status()).toBe(200);
  // The journal of the day reached the server before the summary was asked for.
  const today = riyadhToday();
  const { entries } = await api.get<{ entries: { part: string }[] }>(`/v1/journal?from=${today}&to=${today}`);
  expect(entries.some((e) => e.part === 'evening')).toBe(true);
  expect((await summaryAsked).status()).toBe(200);

  const summary = page.getByRole('region', { name: 'ملخص اليوم من الذكاء' });
  await expect(summary.getByText(FAKE_LINES[0] as string)).toBeVisible();
  await expect(summary.getByText(FAKE_LINES[1] as string)).toBeVisible();

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'evening-summary');
  await api.send('DELETE', '/v1/ai/consent');
});

test('taking the closing back within its window sends nothing and asks for no summary', async ({ paired: page, api }) => {
  await api.send('PUT', '/v1/ai/consent', { provider: 'anthropic', personal_text: false });
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (path === '/v1/day/close' || path === '/v1/events')) requests.push(path);
  });
  // A fake clock instead of a wait: the page's timers (the five-second send, the polling of the
  // queue) are run past the window at once, so a summary that should not be asked for would be.
  await page.clock.install();
  await page.goto('/day/evening');
  await openEveningForm(page);
  await expect(page.getByRole('heading', { name: 'يومية المساء' })).toBeVisible();
  // Different in every run: only this closing could put it on the server.
  const marker = `إنجاز تراجع ${Date.now()}`;
  await page.getByLabel('إنجاز اليوم').fill(marker);
  await page.getByRole('button', { name: 'إغلاق اليوم' }).click();
  await expect(page.getByText('جارٍ الحفظ')).toBeVisible();
  await page.getByRole('button', { name: 'تراجع' }).click();
  await expect(page.getByText('أُلغي الحفظ')).toBeVisible();
  // Ten seconds later by the page's clock: nothing went out and no summary was asked for.
  await page.clock.fastForward(10_000);
  await page.waitForLoadState('networkidle');
  expect(requests).toEqual([]);
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
