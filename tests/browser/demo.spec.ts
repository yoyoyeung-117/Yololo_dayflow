import { test, expect, type Page } from '@playwright/test';

async function realDay(page: Page, empty = false) {
  await page.clock.install({ time: new Date('2026-10-04T07:05:00Z') });
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 4, h - 8, m);
  const friendId = '00000000-0000-4000-8000-000000000001';
  const event = (id: string, start: number, end: number) => ({ id, eventIdentifier: id, calendarId: 'icloud', calendarName: 'Personal', title: id, start, end, allDay: false, editable: true, hasAttendees: false, recurring: false, location: '', modified: 1, busy: true });
  const past = event('Reading session', at(14), at(15)), meeting = event('Research review', at(17), at(18));
  const state: any = { connected: true, monitoring: false, error: null, notificationError: null, refreshedAt: at(15, 5), rules: {}, plan: null, day: { day: '2026-10-04', dayStart: at(0), dayEnd: at(24), timezone: 'Asia/Hong_Kong', revision: 'actual-day', events: empty ? [] : [past, meeting], calendars: [{ id: 'icloud', name: 'Personal', source: 'iCloud', writable: true }] } };
  const actions: { endpoint: string; body: any }[] = [];
  await page.route('**/api/state', async route => { const response = await route.fetch(); const s = await response.json(); s.settings.coworkers = [{ id: friendId, name: 'Alex', platform: 'discord', address: '123456789012345678', enabled: true }]; await route.fulfill({ json: s }); });
  await page.route('**/api/calendar/**', async route => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); actions.push({ endpoint, body });
      if (endpoint === 'rule') state.rules[body.eventId] = { flexible: body.flexible, personIds: body.personIds };
      if (endpoint === 'reschedule') {
        const [h,m] = body.time.split(':').map(Number); const start = at(h,m);
        state.plan = { id: '00000000-0000-4000-8000-000000000002', reschedule: true, automatic: true, day: state.day.day, timezone: state.day.timezone, revision: 'actual-day', source: meeting, assumedEnd: at(15,5), bufferMinutes: body.bufferMinutes, status: 'draft', blockers: [], createdAt: at(15,5), expiresAt: at(15,15), changes: [{ event: meeting, start, end: start + meeting.end - meeting.start, personIds: [friendId], conversation: { activity: [], proposal: { destinationName: 'Discord · #friends', text: 'Move Research review on 2026-10-04 from 17:00–18:00 to 17:30–18:30?', people: [{ id: friendId, name: 'Alex', platform: 'discord', address: '123456789012345678', status: 'pending', delivery: 'not_sent' }] } } }] };
      }
      if (endpoint === 'approve') { state.plan.status = 'coordinating'; state.plan.approvedAt = at(15,5); }
    }
    await route.fulfill({ json: state });
  });
  return { actions, state, friendId };
}

test('former practice link shows the actual date, a ticking clock, real events and next-meeting countdown', async ({ page }) => {
  await realDay(page); await page.goto('/?view=demo');
  await expect(page.getByRole('heading', { name: 'Plan with your real day.' })).toBeVisible();
  await expect(page.getByLabel('Live calendar status')).toContainText('15:05:');
  await expect(page.locator('.date-badge')).toHaveText('4 Oct 2026');
  await expect(page.getByLabel('Live calendar status')).toContainText('Research review · 17:00 · in 115 min');
  await expect(page.locator('.calendar-event').filter({ hasText: 'Reading session' })).toContainText('Ended');
  await expect(page.getByText('Lunch with Professor Lee', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Advance to 1:15 pm' })).toHaveCount(0);
  await page.clock.fastForward(61000);
  await expect(page.getByLabel('Live calendar status')).toContainText('15:06:');
  await expect(page.getByLabel('Live calendar status')).toContainText('in 114 min');
});

test('a real meeting can be changed from My calendar on desktop and mobile, with explicit approval before coordination', async ({ page }) => {
  const h = await realDay(page); await page.goto('/');
  await expect(page).toHaveTitle(/DayMade/);
  await expect(page.locator('.sidebar .brand')).toContainText('DayMade');
  const meeting = page.locator('.calendar-event').filter({ hasText: 'Research review' });
  await meeting.getByLabel('Allow this event to be rescheduled').check(); await meeting.getByLabel('Alex').check();
  await meeting.getByRole('button', { name: 'Change time & ask friends' }).click();
  await expect(page.getByLabel('Meeting to reschedule')).toHaveValue('Research review');
  await page.getByLabel('New start time (Asia/Hong_Kong)', { exact: true }).fill('17:30');
  await page.getByRole('button', { name: 'Review meeting change' }).click();
  expect(h.actions.find(a => a.endpoint === 'reschedule')?.body).toEqual({ eventId: 'Research review', time: '17:30', day: '2026-10-04', bufferMinutes: 10 });
  expect(h.actions.some(a => a.endpoint === 'approve')).toBe(false);
  await expect(page.locator('.calendar-before-after')).toContainText('17:00–18:00');
  await expect(page.locator('.calendar-before-after')).toContainText('17:30–18:30');
  await page.screenshot({ path: 'test-results/real-day-plan-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/real-day-plan-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Let DayMade coordinate & update Calendar' }).click();
  await expect(page.locator('.calendar-plan .pill').first()).toHaveText('coordinating');
  expect(h.actions.filter(a => a.endpoint === 'approve')).toHaveLength(1);
});

test('empty or unavailable Calendar never falls back to invented events', async ({ page }) => {
  await realDay(page, true); await page.goto('/?view=plan');
  await expect(page.getByRole('heading', { name: 'A clear day.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review meeting change' })).toBeDisabled();
  await expect(page.getByLabel('Meeting to reschedule')).toContainText('No future flexible events');
  await expect(page.getByLabel('Live calendar status')).toContainText('No upcoming timed events');
  await expect(page.locator('.calendar-event')).toHaveCount(0);
});

test('all three setup panels and participant platform choices work and persist', async ({ page, request }) => {
  await request.post('/api/settings', { data: { coworkers: [] } });
  await page.goto('/?view=demo');
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('tab', { name: 'Discord', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Discord', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Discord bot token')).toBeVisible();
  await expect(page.getByLabel('Discord channel ID')).toBeVisible();
  await page.getByRole('button', { name: '+ Add coworker' }).click();
  await page.getByLabel('Coworker 1 name').fill('Discord colleague');
  await page.getByLabel('Coworker 1 destination').fill('123456789012345678');
  await page.getByRole('button', { name: 'Save coworkers', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Coworkers saved');
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
  await expect(page.getByText('Your private channel with DayMade: suggestions, approvals and updates.')).toBeVisible();
  await page.getByRole('button', { name: 'Save coworkers', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Coworkers saved');
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
