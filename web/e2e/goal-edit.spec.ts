import { expectNoSeriousA11y } from './a11y';
import { expect, riyadhToday, SYNC_TIMEOUT, test } from './fixtures';
import { expectNoHorizontalScroll, shot } from './shots';

interface StoredEdit {
  id: string;
  page_id: string;
  field: string;
  old_value: string | boolean | null;
  new_value: string | boolean | null;
  note: string;
  status: string;
}

interface StoredTask {
  id: string;
  title: string;
  done_at: string | null;
}

/** `day` plus `n` calendar days, as an ISO day (UTC arithmetic: no zone moves it). */
function plusDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The day as the page writes it (`fmt.day`): the same locale and options. */
function written(day: string): string {
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}

// The late milestone of the seed (two days late) belongs to O1. The two projects share one database,
// so each moves it to a day of its own, and neither depends on what the other did.
const LATE = 'e2e-ms-1';
const OFFSET = { desktop: 6, mobile: 9 } as const;

test('the due date of the late milestone is edited, and stays pending after a reload', async ({
  paired: page,
  api,
  projectName,
}) => {
  const day = plusDays(riyadhToday(), OFFSET[projectName]);

  await page.goto('/goals/O1');
  await expect(page.getByRole('heading', { level: 1, name: /الصحة الجسدية/ })).toBeVisible();
  const row = page.locator(`[data-milestone="${LATE}"]`);
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: /^تعديل الموعد/ }).click();
  await row.getByLabel('الموعد').fill(day);
  await row.getByRole('button', { name: 'حفظ' }).click();

  await expect(row.getByText('معلّق')).toBeVisible();
  await expect(row.getByText(written(day))).toBeVisible();
  // the keyboard stays where it was: on «تعديل» of the field that was saved
  await expect(row.getByRole('button', { name: /^تعديل الموعد/ })).toBeFocused();
  // the title of a milestone is a link with a target of 44px at least
  const box = await row.getByRole('link', { name: 'قياس خط الأساس' }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('region', { name: 'سجل التعديلات' }).getByText('معلّق').first()).toBeVisible();

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'goal-detail-edited');

  // The new date and the badge are the server's, not the page's: they survive a reload.
  await page.reload();
  const again = page.locator(`[data-milestone="${LATE}"]`);
  await expect(again.getByText(written(day))).toBeVisible();
  await expect(again.getByText('معلّق')).toBeVisible();

  // And the log of the server holds one pending edit, with the previous value in its note.
  const { items } = await api.get<{ items: StoredEdit[] }>('/v1/goal-edits');
  const pending = items.filter((e) => e.page_id === LATE && e.field === 'due_date' && e.status === 'pending');
  expect(pending, 'one pending edit of the due date').toHaveLength(1);
  expect(pending[0]?.new_value).toBe(day);
  expect(pending[0]?.note).toContain('من');
  expect(pending[0]?.note).toContain('إلى');
  expect(pending[0]?.note).toContain(day);

  await expectNoSeriousA11y(page);
  await shot(page, 'goal-detail-reloaded');
});

// The milestones of O3 in the seed: each project closes one of its own.
const CLOSE = { desktop: 'e2e-ms-5', mobile: 'e2e-ms-6' } as const;

test('closing a milestone moves the summary and the pace with its row', async ({ paired: page, projectName }) => {
  await page.goto('/goals/O3');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const summary = page.getByRole('region', { name: 'الهدف' });
  const counted = async (): Promise<number> => {
    const text = (await summary.getByText(/من \d+ محطة/).innerText()).replace(/\D+/g, ' ').trim().split(' ');
    return Number(text[0]);
  };
  const paced = async (): Promise<number> => {
    const label = (await page.getByRole('img', { name: /القيمة/ }).getAttribute('aria-label')) ?? '';
    return Number(/القيمة (\d+)/.exec(label)?.[1]);
  };
  await expect(page.getByRole('img', { name: /القيمة/ })).toBeVisible();
  const before = { summary: await counted(), pace: await paced() };

  const row = page.locator(`[data-milestone="${CLOSE[projectName]}"]`);
  await row.getByRole('checkbox', { name: /^منجزة/ }).check();
  await expect(row.getByText('معلّق')).toBeVisible();

  // the row, the summary and the pace agree, without a reload
  await expect.poll(counted).toBe(before.summary + 1);
  await expect.poll(paced).toBe(before.pace + 1);
  await expectNoSeriousA11y(page);
  await shot(page, 'goal-detail-closed');
});

test('a task is added and ticked, and the tick reaches the server', async ({ paired: page, api, projectName }) => {
  const title = `مهمة ${projectName} ${Date.now()}`;
  await page.goto('/goals/O3');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const tasks = page.getByRole('region', { name: 'المهام' });

  await tasks.getByLabel('عنوان المهمة').fill(title);
  await tasks.getByRole('button', { name: 'إضافة مهمة' }).click();
  const item = tasks.getByRole('button', { name: new RegExp(title) });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('aria-pressed', 'false');

  await item.click();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  await expect(tasks.getByText(/^\d+ من \d+$/)).toBeVisible();

  await expectNoSeriousA11y(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'goal-detail-tasks');

  // The outbox sends the tick a few seconds later; the server then holds the task as done.
  await expect
    .poll(
      async () => {
        const { items } = await api.get<{ items: StoredTask[] }>('/v1/goals/O3/tasks');
        return items.find((t) => t.title === title)?.done_at ?? null;
      },
      { timeout: SYNC_TIMEOUT },
    )
    .not.toBeNull();
});

test('the page is reachable by keyboard: the actions first, then the editable values', async ({ paired: page }) => {
  await page.goto('/goals/O1');
  await expect(page.getByRole('heading', { level: 1, name: /الصحة الجسدية/ })).toBeVisible();
  // start from the heading, where the shell puts focus when a page opens
  await page.getByRole('heading', { level: 1 }).evaluate((h) => {
    h.setAttribute('tabindex', '-1');
    h.focus();
  });
  const rings: { label: string; ring: boolean; checkbox: boolean }[] = [];
  const stop = async (): Promise<string> => {
    await page.keyboard.press('Tab');
    const now = await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement;
      const style = getComputedStyle(el);
      return {
        label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
        // the ring of the design (a shadow), or the browser's own outline on a plain link
        ring: style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && style.outlineWidth !== '0px'),
        checkbox: el.type === 'checkbox',
      };
    });
    rings.push(now);
    return now.label;
  };
  // the one prominent action, then the secondary one
  expect(await stop()).toBe('عادة من هذا الهدف');
  expect(await stop()).toBe('بدء تركيز');
  const later: string[] = [];
  for (let i = 0; i < 10; i += 1) later.push(await stop());
  expect(later.some((s) => s.startsWith('تعديل الموعد'))).toBe(true);
  // a focus ring is drawn on every stop: the
  // indicator card is among these stops now, so the check covers all of them, not only the last
  expect(rings.filter((r) => !r.checkbox && !r.ring).map((r) => r.label)).toEqual([]);
});
