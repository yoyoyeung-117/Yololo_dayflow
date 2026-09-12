import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/api/replay/reset', { data: { mode: 'replay' } }); });

test('complete replay with actual UI actions, stale approval prevention, and recorded agreement', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little room in your day.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dayflow-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Advance to 1:15 pm' }).click();
  await expect(page.getByRole('button', { name: 'Approve replay proposal' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose another time' }).click();
  await page.getByLabel('New meeting time', { exact: true }).fill('14:15');
  await page.getByRole('button', { name: 'Prepare proposal', exact: true }).click();
  await expect(page.locator('.time-change')).toContainText('2:15');
  await page.getByRole('button', { name: 'Approve replay proposal' }).click();
  await expect(page.getByLabel('Coworker reply')).toBeVisible();
  await page.getByLabel('Coworker reply').fill('yes');
  await page.getByRole('button', { name: 'Submit simulated reply' }).click();
  await expect(page.getByText('1/2 agreed')).toBeVisible();
  await page.getByLabel('Try a coworker’s reply').selectOption('sam');
  await page.getByLabel('Coworker reply').fill('yes');
  await page.getByRole('button', { name: 'Submit simulated reply' }).click();
  await expect(page.getByText('2/2 agreed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Everyone’s on the same page.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dayflow-agreement.png', fullPage: true });
  await page.reload(); await expect(page.getByText('2/2 agreed')).toBeVisible();
  expect(errors).toEqual([]);
});

test('live delivery requires WhatsApp setup and settings are keyboard accessible', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'WhatsApp live', exact: true }).click();
  await page.getByRole('button', { name: 'Connect WhatsApp to continue' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Twilio Account SID')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save & verify Twilio' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Simulated WhatsApp', exact: true }).click();
});

test('mobile layout has no horizontal overflow and approval remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Advance to 1:15 pm' }).click();
  await expect(page.getByRole('button', { name: 'Approve replay proposal' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/dayflow-mobile.png', fullPage: true });
});
