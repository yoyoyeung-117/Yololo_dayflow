import { test, expect } from '@playwright/test';

test('Calendar is the default workspace, with an accessible connection flow on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little ahead of your day.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Apple Calendar', exact: true })).toBeVisible();
  await expect(page.getByText('This does not track your iPhone location.', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-results/calendar-connect-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Practice scenario', exact: true }).click();
  await expect(page.getByLabel('Demo controls')).toBeVisible();
});

test('Calendar timeline maps friends, previews the full ripple, and exposes approval without sending on preview', async ({ page }) => {
  const now = Date.now(), friendId = '00000000-0000-4000-8000-000000000001';
  const e = (id: string, start: number, end: number) => ({ id, eventIdentifier: id, calendarId: 'test', calendarName: 'iCloud Personal', title: id, start, end, allDay: false, editable: true, hasAttendees: false, recurring: false, location: '', modified: 0, busy: true });
  const lunch = e('Lunch with professor', now - 3600000, now - 300000), friends = e('Coffee with Alex', now + 600000, now + 2400000);
  let approvals = 0;
  const state: any = { connected: true, error: null, notificationError: null, monitoring: false, refreshedAt: now, rules: {}, plan: null, day: { day: '2026-09-12', dayStart: now - 40000000, dayEnd: now + 40000000, timezone: 'Asia/Hong_Kong', revision: 'fixture', events: [lunch, friends], calendars: [{ id: 'test', name: 'Personal', source: 'iCloud', writable: true }] } };
  await page.route('**/api/state', async route => { const response = await route.fetch(); const json = await response.json(); json.settings.coworkers = [{ id: friendId, name: 'Alex', platform: 'discord', address: '123456789012345678', enabled: true }]; await route.fulfill({ json }); });
  await page.route('**/api/calendar/**', async route => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1), body = route.request().method() === 'POST' ? route.request().postDataJSON() : {};
    if (endpoint === 'rule') state.rules[body.eventId] = { flexible: body.flexible, personIds: body.personIds };
    if (endpoint === 'preview') state.plan = { id: '00000000-0000-4000-8000-000000000002', day: state.day.day, timezone: state.day.timezone, revision: 'fixture', source: lunch, assumedEnd: now + 900000, bufferMinutes: 10, changes: [{ event: friends, start: now + 1500000, end: now + 3300000, personIds: [friendId], conversation: { proposal: { text: 'Could we move coffee 15 minutes later? Reply #DF-ABC123 yes.', destinationName: 'Discord · #friends', people: [{ id: friendId, name: 'Alex', platform: 'discord', address: '123456789012345678', status: 'pending', delivery: 'not_sent' }] } } }], blockers: [], status: 'draft', createdAt: now, expiresAt: now + 600000 };
    if (endpoint === 'approve') { approvals++; state.plan.status = 'coordinating'; }
    await route.fulfill({ json: state });
  });
  await page.goto('/');
  const coffee = page.locator('.calendar-event').filter({ hasText: 'Coffee with Alex' });
  await coffee.getByLabel('Allow this event to move later').check();
  await coffee.getByLabel('Alex').check();
  await page.getByRole('button', { name: 'Review the rest of my day' }).click();
  await expect(page.getByRole('heading', { name: 'Your proposed changes' })).toBeVisible();
  await expect(page.getByText('Could we move coffee 15 minutes later? Reply #DF-ABC123 yes.')).toBeVisible();
  expect(approvals).toBe(0);
  await page.screenshot({ path: 'test-results/calendar-plan-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/calendar-plan-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Approve messages & calendar changes', exact: true }).click();
  await expect(page.getByText('coordinating', { exact: true })).toBeVisible();
  expect(approvals).toBe(1);
});
