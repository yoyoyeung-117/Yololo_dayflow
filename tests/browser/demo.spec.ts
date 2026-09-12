import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/api/replay/reset', { data: { mode: 'replay' } }); });

test('complete replay with actual UI actions, stale approval prevention, and recorded agreement', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?view=demo');
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

test('live delivery requires coworker setup and settings are keyboard accessible', async ({ page }) => {
  await page.goto('/?view=demo');
  await expect(page.getByLabel('Message delivery status')).toContainText('Approvals will not post to Discord or Zoom');
  await page.getByRole('button', { name: 'Switch to live messages', exact: true }).click();
  await expect(page.getByLabel('Message delivery status')).toContainText('No coworkers are selected');
  await page.getByRole('button', { name: 'Connect coworkers to continue' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Telegram bot token')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save & pair Telegram' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Simulated messages', exact: true }).click();
});

test('mobile layout has no horizontal overflow and approval remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=demo');
  await page.getByRole('button', { name: 'Advance to 1:15 pm' }).click();
  await expect(page.getByRole('button', { name: 'Approve replay proposal' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/dayflow-mobile.png', fullPage: true });
});

test('all three setup panels and participant platform choices work and persist', async ({ page, request }) => {
  await request.post('/api/settings', { data: { coworkers: [] } });
  await page.goto('/?view=demo');
  await page.getByRole('button', { name: 'Discord You ↔ coworkers · team channel Set up' }).click();
  await expect(page.getByRole('tab', { name: 'Discord', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Discord bot token')).toBeVisible();
  await expect(page.getByLabel('Discord channel ID')).toBeVisible();
  await page.getByRole('button', { name: '+ Add coworker' }).click();
  await page.getByLabel('Coworker 1 name').fill('Discord colleague');
  await page.getByLabel('Coworker 1 destination').fill('123456789012345678');
  await page.getByRole('button', { name: 'Save coworkers', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Coworkers saved');
  await page.getByRole('tab', { name: 'Zoom', exact: true }).click();
  await expect(page.getByLabel('Zoom client ID')).toBeVisible();
  await expect(page.getByText('team_chat:read:list_user_messages', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/dayflow-zoom-setup.png', fullPage: true });
  await page.getByRole('tab', { name: 'Telegram', exact: true }).click();
  await page.getByRole('button', { name: '+ Add coworker' }).click();
  await page.getByLabel('Coworker 2 name').fill('Zoom colleague');
  await expect(page.getByLabel('Coworker 2 platform').locator('option')).toHaveText(['Discord', 'Zoom Team Chat']);
  await page.getByLabel('Coworker 2 platform').selectOption('zoom');
  await page.getByLabel('Coworker 2 destination').fill('colleague@example.com');
  await expect(page.getByRole('button', { name: 'Create invitation', exact: true })).toHaveCount(0);
  await expect(page.getByText('Your private channel with Dayflow: suggestions, approvals and updates.')).toBeVisible();
  await page.getByRole('button', { name: 'Save coworkers', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Coworkers saved');
  await page.getByRole('button', { name: 'Close connections' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(page.getByLabel('Coworker 1 destination')).toHaveValue('123456789012345678');
  await expect(page.getByLabel('Coworker 2 platform')).toHaveValue('zoom');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/dayflow-telegram-setup-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Close connections' }).click();
  await request.post('/api/settings', { data: { coworkers: [] } });
});
