import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expectNoSeriousA11y } from './a11y';
import { type Api, expect, riyadhToday, sharedStateTest as test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

// The review page against the real test server and the fake provider (no network, no key). The
// journal and the mood are put in through the events route for days of their own, so nothing here
// depends on what the other specs wrote today; the checks name the marker of this run and the
// words of the page, never counts that another spec could change.

const FAKE_LINE = 'ملخص تجريبي لليوم.';

function daysBefore(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
}

/** One journal event and one mood event for each of two past days, ids made here. */
async function seed(api: Api, offsets: [number, number], marker: string, mood: number): Promise<{ first: string; second: string }> {
  const today = riyadhToday();
  const [first, second] = [daysBefore(today, offsets[0]), daysBefore(today, offsets[1])];
  const at = (day: string, hour: string): string => `${day}T${hour}:00:00+03:00`;
  const events = [
    { type: 'journal_saved', day: first, hour: '08', payload: { part: 'morning', day: first, answers: { priorities: [], gratitude: [], note: `${marker} صباح` } } },
    { type: 'journal_saved', day: first, hour: '21', payload: { part: 'evening', day: first, answers: { one_minute: false, priorities: [], gratitude: [], win: `${marker} مساء` } } },
    { type: 'mood_logged', day: first, hour: '21', payload: { day: first, score: mood, feelings: ['calm', 'focused'], activities: [] } },
    { type: 'journal_saved', day: second, hour: '08', payload: { part: 'morning', day: second, answers: { priorities: [], gratitude: [], note: `${marker} صباح ثانٍ` } } },
    { type: 'mood_logged', day: second, hour: '21', payload: { day: second, score: 2, feelings: [], activities: [] } },
  ].map((e) => ({ id: randomUUID(), type: e.type, occurred_at: at(e.day, e.hour), payload: e.payload }));
  await api.send('POST', '/v1/events', { events });
  return { first, second };
}

async function tab(page: Page, name: 'الأسبوع' | 'السجل' | 'المزاج'): Promise<void> {
  await page.getByRole('radio', { name, exact: true }).click();
  await expect(page.getByRole('radio', { name, exact: true })).toBeChecked();
}

test('the review: the week with its insight, the journal timeline and the mood, then the saved copy offline', async ({
  paired: page,
  api,
  context,
  projectName,
}) => {
  const marker = `مراجعة ${projectName} ${Date.now()}`;
  // Each project has its own two days, so the two never write the same day's mood.
  const { first } = await seed(api, projectName === 'desktop' ? [2, 3] : [4, 5], marker, projectName === 'desktop' ? 4 : 5);
  await api.send('DELETE', '/v1/ai/consent');

  // ---- the week ----
  await page.goto('/review');
  await expect(page.getByRole('heading', { level: 1, name: 'المراجعة' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'الأسبوع', exact: true })).toBeChecked();
  const figures = page.getByRole('list', { name: 'أرقام الأسبوع' });
  await expect(figures).toBeVisible();
  await expect(figures.getByRole('listitem').filter({ hasText: 'يومية الصباح' })).toHaveCount(1);
  for (const name of ['تمّ', 'معطَّل', 'التالي']) await expect(page.getByRole('list', { name, exact: true })).toBeVisible();
  // «توليد مراجعة الأسبوع» until a review is shown; «إعادة التوليد» once one is (the other project may have made it)
  const generate = page.getByRole('button', { name: /^(توليد مراجعة الأسبوع|إعادة التوليد)$/ });
  await expect(generate).toBeVisible();
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'review-week');

  // Nothing is asked by visiting. One press: the consent first (none yet), then the one request.
  const weeklyPosts: number[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/v1/insights/weekly') weeklyPosts.push(r.status());
  });
  await generate.click();
  const consent = page.getByRole('dialog', { name: /Anthropic/ });
  await expect(consent).toBeVisible();
  await expectNoSeriousA11y(page);
  await consent.getByRole('button', { name: 'موافقة' }).click();
  await expect(page.getByText(FAKE_LINE)).toBeVisible();
  await expect(page.getByRole('button', { name: 'إعادة التوليد' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'توليد مراجعة الأسبوع' })).toHaveCount(0);
  // the first try was refused for want of the consent, the second answered
  await expect.poll(() => weeklyPosts.filter((s) => s !== 401)).toEqual([403, 200]);
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'review-week-insight');
  await expect(page.getByRole('region', { name: 'المراجعات السابقة' })).toBeVisible();

  // ---- the journal ----
  await tab(page, 'السجل');
  await expect(page).toHaveURL(/\/review\?tab=journal$/);
  await expect(page.getByText(`${marker} مساء`)).toBeVisible();
  await expect(page.getByText(`${marker} صباح`, { exact: true })).toBeVisible();
  const entries = page.getByRole('list', { name: 'إدخالات اليوميات' });
  // the feelings of the day sit with its evening entry
  await expect(entries.getByRole('list', { name: 'المشاعر' }).first()).toContainText('هدوء');
  await expect(page.getByRole('list', { name: 'ملخص الأشهر' }).getByText(/للوعي الذاتي$/).first()).toBeVisible();
  // the commitment of the month: the habit days kept, as a percent
  await expect(page.getByRole('list', { name: 'ملخص الأشهر' }).getByText(/^الالتزام بالعادات اليومية: .\d+%. \(\d+ من \d+\)$/).first()).toBeVisible();
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'review-journal');

  // ---- the mood ----
  await tab(page, 'المزاج');
  await expect(page).toHaveURL(/\/review\?tab=mood$/);
  const grid = page.getByRole('img', { name: /^المزاج في \d{4}/ });
  await expect(grid).toBeVisible();
  await expect(page.getByRole('list', { name: 'مفتاح درجات المزاج' }).getByRole('listitem')).toHaveCount(5);
  await expect(grid.locator(`[data-day="${first}"]`)).toHaveAttribute('data-score', /^[45]$/);
  await expect(page.getByText('لا بيانات كافية')).toBeVisible();
  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'review-mood');

  // ---- without a connection: the saved copy of a tab that was read, and the AI says it needs one ----
  await tab(page, 'السجل');
  await expect(page.getByText(`${marker} مساء`)).toBeVisible();
  await tab(page, 'الأسبوع');
  await expect(figures).toBeVisible();
  await context.setOffline(true);
  await tab(page, 'السجل');
  await expect(page.getByText('نسخة محفوظة · بلا اتصال')).toBeVisible();
  await expect(page.getByText(`${marker} مساء`)).toBeVisible();
  await expectNoSeriousA11y(page);
  await shot(page, 'review-journal-offline');
  await tab(page, 'الأسبوع');
  await expect(page.getByText('نسخة محفوظة · بلا اتصال')).toBeVisible();
  // Offline the button is off and says why: there is nothing to press (Task 24; it used to be pressed
  // to find out), and no second retry button.
  await expect(page.getByRole('button', { name: 'إعادة التوليد' })).toBeDisabled();
  await expect(page.getByText('يحتاج اتصالاً')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, 'review-week-offline');
  await context.setOffline(false);

  await api.send('DELETE', '/v1/ai/consent');
});
