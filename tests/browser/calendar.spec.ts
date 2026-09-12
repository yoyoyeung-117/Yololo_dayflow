import { test, expect } from '@playwright/test';

test('Calendar is the default workspace, with an accessible connection flow on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little ahead of your day.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Apple Calendar', exact: true })).toBeVisible();
  await expect(page.getByText('This does not track your iPhone location.', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-results/calendar-connect-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Plan my day', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Plan with your real day.' })).toBeVisible();
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
    if (endpoint === 'preview') state.plan = { automatic: true, id: '00000000-0000-4000-8000-000000000002', day: state.day.day, timezone: state.day.timezone, revision: 'fixture', source: lunch, assumedEnd: now + 900000, bufferMinutes: 10, changes: [{ event: friends, start: now + 1500000, end: now + 3300000, personIds: [friendId], conversation: { activity: [], proposal: { text: 'Could we move coffee 15 minutes later? Reply #DF-ABC123 yes.', destinationName: 'Discord · #friends', people: [{ id: friendId, name: 'Alex', platform: 'discord', address: '123456789012345678', status: 'pending', delivery: 'not_sent' }] } } }], blockers: [], status: 'draft', createdAt: now, expiresAt: now + 600000 };
    if (endpoint === 'approve') { approvals++; state.plan.status = 'coordinating'; }
    await route.fulfill({ json: state });
  });
  await page.goto('/');
  const coffee = page.locator('.calendar-event').filter({ hasText: 'Coffee with Alex' });
  await coffee.getByLabel('Allow this event to be rescheduled').check();
  await coffee.getByLabel('Alex').check();
  await page.getByRole('button', { name: 'Review the rest of my day' }).click();
  await expect(page.getByRole('heading', { name: 'Your proposed changes' })).toBeVisible();
  await expect(page.getByText('Could we move coffee 15 minutes later? Reply #DF-ABC123 yes.')).toBeVisible();
  expect(approvals).toBe(0);
  await page.screenshot({ path: 'test-results/calendar-plan-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/calendar-plan-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Let DayMade coordinate & update Calendar', exact: true }).click();
  await expect(page.getByText('coordinating', { exact: true })).toBeVisible();
  expect(approvals).toBe(1);
});

test('teammate request inbox lets the owner accept or suggest a time without opening Discord', async ({ page }) => {
  const state: any = { enabled: true, since: Date.now(), error: null, requests: [{ id: '00000000-0000-4000-8000-000000000010', incomingId: 'discord:1', sender: { name: 'Alex' }, text: 'Can we move Coffee from 17:00 to 17:30?', createdAt: Date.now(), expiresAt: Date.now() + 600000, status: 'awaiting_owner', requestedTime: '17:30', selectedTime: '17:30', timezone: 'Asia/Hong_Kong', day: '2026-09-12', event: { title: 'Coffee', start: Date.UTC(2026, 8, 12, 9), end: Date.UTC(2026, 8, 12, 9, 30) } }] };
  let response: any;
  await page.route('**/api/requests/**', async route => {
    if (route.request().method() === 'POST') { response = route.request().postDataJSON(); state.requests[0].status = 'coordinating'; state.requests[0].selectedTime = response.time || '17:30'; }
    await route.fulfill({ json: state });
  });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Requests from your friends' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept 17:30', exact: true })).toBeVisible();
  await page.getByLabel('Another time for Coffee').fill('18:00');
  await page.screenshot({ path: 'test-results/teammate-request-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/teammate-request-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Propose this time', exact: true }).click();
  await expect(page.locator('.teammate-inbox').getByText('coordinating', { exact: true })).toBeVisible();
  expect(response).toEqual({ id: state.requests[0].id, choice: 'accept', time: '18:00' });
});

test('Discord disconnect control pauses locally and keeps its saved configuration visible', async ({ page }) => {
  let disconnected = false;
  await page.route('**/api/state', async route => { const response = await route.fetch(); const json = await response.json(); json.integrations.discord = { ...json.integrations.discord, configured: true, connected: !disconnected, paused: disconnected, channelName: 'friends', botName: 'DayMade' }; await route.fulfill({ json }); });
  await page.route('**/api/discord/disconnect', async route => { disconnected = true; await route.fulfill({ json: { ok: true } }); });
  await page.goto('/'); await page.getByRole('button', { name: 'Set up friends & messaging' }).click();
  await page.getByRole('tab', { name: 'Discord', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect Discord', exact: true }).click();
  await expect(page.getByText('Disconnected · setup saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect Discord', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save & connect Discord', exact: true })).toBeEnabled();
  expect(disconnected).toBe(true);
});
