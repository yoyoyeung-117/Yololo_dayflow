import { test, expect } from '@playwright/test';

test('real venues, online links, travel warning and review control work on desktop and mobile', async ({ page }) => {
  const now = Date.UTC(2026, 9, 4, 8, 45), at = (h: number, m = 0) => Date.UTC(2026, 9, 4, h - 8, m);
  await page.clock.install({ time: new Date(now) });
  const event = { id: 'real-review', title: 'Research review', eventIdentifier: 'real-review', calendarId: 'work', calendarName: 'Work', start: at(17), end: at(18), allDay: false, editable: true, hasAttendees: false, recurring: false, location: 'HKUST, Clear Water Bay, Hong Kong', modified: 1, busy: true };
  const online = { ...event, id: 'video', title: 'Online study session', start: at(20), end: at(21), location: 'Zoom', online: true, joinUrl: 'https://zoom.us/j/123456?pwd=calendar-link' };
  const calendar = { connected: true, monitoring: false, error: null, notificationError: null, day: { day: '2026-10-04', timezone: 'Asia/Hong_Kong', dayStart: at(0), dayEnd: at(24), revision: 'real', calendars: [], events: [event, online] }, rules: { 'real-review': { flexible: true, personIds: [] } }, plan: null, refreshedAt: now };
  const travel: any = { settings: { enabled: false, mode: 'driving', bufferMinutes: 10, origin: { source: 'address', address: 'Central MTR Station, Hong Kong', label: 'Central MTR Station, Hong Kong', updatedAt: now } }, estimate: { event, checkedAt: now, provider: 'Apple Maps', seconds: 1800, travelMinutes: 30, meters: 18330, bufferMinutes: 10, readyAt: at(17, 25), leaveBy: at(16, 20), lateMinutes: 25, mapsUrl: 'https://maps.apple.com/?saddr=22.28,114.15&daddr=22.33,114.26&dirflg=d', origin: { latitude: 22.28, longitude: 114.15 }, destination: { latitude: 22.33, longitude: 114.26 } }, status: 'Route checked with Apple Maps. Arrival assumes you leave now.', checking: false, error: null, notificationError: null, online: [online] };
  const actions: string[] = [];
  await page.route('**/api/calendar/state', route => route.fulfill({ json: calendar }));
  await page.route('**/api/state', async route => { const r = await route.fetch(); const s = await r.json(); s.integrations.telegram.connected = true; await route.fulfill({ json: s }); });
  await page.route('**/api/travel/**', route => { if (route.request().method() === 'POST') { const name = new URL(route.request().url()).pathname.split('/').at(-1)!; actions.push(name); if (name === 'disconnect') { travel.settings.origin = null; travel.settings.enabled = false; travel.estimate = null; } } return route.fulfill({ json: travel }); });
  await page.goto('/?view=plan');
  await expect(page.locator('.profile')).toContainText('Yoyo'); await expect(page.locator('.profile')).toContainText('Yololo');
  await expect(page.locator('.calendar-event').filter({ hasText: 'Research review' })).toContainText(event.location);
  await expect(page.locator('.event-venue').getByRole('link', { name: 'View real venue in Apple Maps' })).toHaveAttribute('href', /maps\.apple\.com/);
  await expect(page.locator('.online-meeting').getByRole('link', { name: 'Join online meeting' })).toHaveAttribute('href', online.joinUrl);
  await expect(page.locator('.travel-result')).toContainText('Likely late'); await expect(page.locator('.travel-metrics')).toContainText('40 min');
  await expect(page.locator('.travel-result')).toContainText('17:25');
  expect(actions).toEqual([]);
  await page.getByRole('button', { name: 'Find a later time & review' }).click(); expect(actions).toEqual(['propose']);
  await page.screenshot({ path: 'test-results/travel-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/travel-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Disconnect travel & reminders' }).click(); await expect(page.locator('.travel-result')).toHaveCount(0);
});
