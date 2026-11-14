import { expect, sharedStateTest as test } from './fixtures';
import { expectNoSeriousA11y } from './a11y';
import { expectLayerFits, shot } from './shots';

// Every dialog and drawer, at 1280x800 and 390x844: the panel and its actions are inside the window
// (the body scrolls, the footer stays), and axe finds nothing serious in them.

test('the indicator dialog, with a reminder added, keeps «حفظ» in sight', async ({ paired: page, projectName }) => {
  await page.goto(`/habits/e2e_tick_${projectName}`);
  const card = page.getByRole('region', { name: 'المؤشر' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'تخصيص وإضافة تذكير' }).click();
  const dialog = page.getByRole('dialog', { name: 'تخصيص المؤشر' });
  await expect(dialog).toBeVisible();
  const add = dialog.getByRole('button', { name: /إضافة تذكير/ });
  if (await add.isVisible()) await add.click();
  await expectLayerFits(page);
  await expect(dialog.getByRole('button', { name: 'حفظ', exact: true })).toBeVisible();
  await expectNoSeriousA11y(page);
  await shot(page, 'layer-indicator-dialog');
});

test('the ask drawer and the consent dialog fit the window', async ({ paired: page, api }) => {
  await api.send('DELETE', '/v1/ai/consent');
  await page.keyboard.press('Control+KeyK');
  const drawer = page.getByRole('dialog', { name: 'اسأل' });
  await expect(drawer).toBeVisible();
  await expectLayerFits(page);
  await shot(page, 'layer-ask-drawer');
  await drawer.getByLabel('السؤال').fill('ما حالة أهدافي؟');
  await drawer.getByRole('button', { name: 'سؤال', exact: true }).click();
  const consent = page.getByRole('dialog', { name: /Anthropic/ });
  await expect(consent).toBeVisible();
  await expectLayerFits(page);
  await expectNoSeriousA11y(page);
  await shot(page, 'layer-consent');
  await page.keyboard.press('Escape');
  await api.send('DELETE', '/v1/ai/consent');
});

test('the memory reset dialog fits the window', async ({ paired: page, api }) => {
  // «إعادة ضبط كاملة» is off while the memory is empty: one note first.
  await api.send('DELETE', '/v1/ai/memory');
  await api.send('POST', '/v1/ai/memory', { kind: 'note', text: 'ملاحظة للاختبار' });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'إعادة ضبط كاملة' }).click();
  const dialog = page.getByRole('dialog', { name: 'إعادة ضبط الذاكرة' });
  await expect(dialog).toBeVisible();
  await expectLayerFits(page);
  await expectNoSeriousA11y(page);
  await shot(page, 'layer-memory-reset');
  await page.keyboard.press('Escape');
  await api.send('DELETE', '/v1/ai/memory');
});
