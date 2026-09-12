import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { TravelAgent, arrivalSlot } from '../server/travel.js';
import type { CalendarAgent } from '../server/calendar.js';
import type { CalendarDay, CalendarEvent, CalendarSnapshot } from '../shared/calendar.js';
import { safeJoinUrl, type MapRoute } from '../shared/travel.js';
const base = Date.UTC(2026, 8, 12), at = (h: number, m = 0) => base + (h * 60 + m) * 60000;
const event = (id: string, start: number, end: number): CalendarEvent => ({ id, title: id, eventIdentifier: id, calendarId: 'personal', calendarName: 'Personal', start, end, allDay: false, busy: true, editable: true, hasAttendees: false, recurring: false, location: 'Actual calendar address', modified: 1 });
function harness(t: { after: (fn: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-travel-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = at(16, 45), calls = 0, fail = false;
  const day: CalendarDay = { day: '2026-09-12', dayStart: base, dayEnd: base + 86400000, timezone: 'UTC', revision: 'real-v1', calendars: [], events: [event('Review', at(17), at(18)), event('Fixed call', at(18), at(19))] };
  const state: CalendarSnapshot = { connected: true, monitoring: false, day, rules: { Review: { flexible: true, personIds: ['friend'] } }, plan: null, error: null, notificationError: null, refreshedAt: now };
  const plans: unknown[][] = [], notices: { text: string; buttons: any }[] = [];
  const calendar = { state, working: false, active: false, refresh: async () => { state.refreshedAt = now; return day; }, reschedule: async (...args: unknown[]) => { plans.push(args); } } as unknown as CalendarAgent;
  const route: MapRoute = { seconds: 1800, meters: 15000, origin: { latitude: 22.3, longitude: 114.1 }, destination: { latitude: 22.33, longitude: 114.26 }, provider: 'Apple Maps' };
  const agent = new TravelAgent(new Store(directory), calendar, async () => { calls++; if (fail) throw new Error('Maps unavailable'); return route; }, async (text, buttons) => { notices.push({ text, buttons }); }, () => true, () => now);
  const configure = () => agent.configure({ enabled: true, origin: { source: 'address', label: 'My current address', address: 'My current address', updatedAt: now } });
  return { agent, state, day, plans, notices, calls: () => calls, configure, clock: (n: number) => { now = n; }, fail: () => { fail = true; }, store: new Store(directory), calendar, route };
}
test('actual route plus buffer warns once, checks whole day and only prepares a review after the owner asks', async t => {
  const h = harness(t); h.configure(); await h.agent.tick();
  assert.equal(h.agent.state.estimate?.travelMinutes, 30); assert.equal(h.agent.state.estimate?.lateMinutes, 25);
  assert.equal(h.agent.state.estimate?.leaveBy, at(16, 20)); assert.equal(h.notices.length, 1); assert.match(h.notices[0].text, /Review.*17:00/s);
  assert.equal(h.plans.length, 0); await h.agent.tick(); assert.equal(h.notices.length, 1); assert.equal(h.calls(), 1);
  const id = h.notices[0].buttons[0][0].callback_data.split(':')[1]; await h.agent.action(id);
  assert.deepEqual(h.plans[0], ['Review', '19:10', '2026-09-12', 10, at(17, 25)]);
});
test('online reminders work without a location and include the real joining link; no route for online meetings', async t => {
  const h = harness(t); h.day.events = [{ ...event('Video discussion', at(16, 50), at(17, 20)), online: true, joinUrl: 'https://zoom.us/j/123?pwd=actual' }];
  h.agent.configure({ enabled: true }); await h.agent.tick(); await h.agent.tick();
  assert.equal(h.calls(), 0); assert.equal(h.notices.length, 1); assert.match(h.notices[0].text, /https:\/\/zoom.us\/j\/123\?pwd=actual/); assert.equal(h.notices[0].buttons, undefined); assert.equal(h.agent.state.estimate, null);
});
test('missing venue, stale location and map failure never produce fictional travel times', async t => {
  const h = harness(t); h.configure(); h.day.events[0].location = ''; await h.agent.tick(); assert.equal(h.calls(), 0); assert.match(h.agent.state.status, /no venue/);
  h.day.events[0].location = 'Real venue'; h.clock(at(17, 16)); await h.agent.check(true); assert.equal(h.calls(), 0); assert.match(h.agent.state.status, /old or too imprecise/);
  h.configure(); h.fail(); await h.agent.check(true); assert.equal(h.agent.state.estimate, null); assert.equal(h.agent.state.error, 'Maps unavailable'); assert.equal(h.notices.length, 0);
});
test('disconnect clears starting location and invalidates pending Telegram travel actions', async t => {
  const h = harness(t); h.configure(); await h.agent.tick(); const id = h.notices[0].buttons[0][0].callback_data.split(':')[1];
  h.agent.disconnect(); assert.equal(h.agent.state.settings.origin, null); await h.agent.tick();
  await assert.rejects(async () => h.agent.action(id), /expired/); assert.equal(h.plans.length, 0); assert.equal(h.calls(), 1);
});
test('changing the origin while Maps is calculating discards the old route', async t => {
  const h = harness(t); let finish!: (route: MapRoute) => void;
  const agent = new TravelAgent(h.store, h.calendar, () => new Promise(resolve => { finish = resolve; }), async () => {}, () => true, () => at(16, 45));
  agent.configure({ origin: { source: 'address', label: 'Old place', address: 'Old place', updatedAt: at(16, 45) } });
  const pending = agent.check(true); await new Promise(resolve => setImmediate(resolve)); agent.disconnect(); finish(h.route); await pending;
  assert.equal(agent.state.estimate, null); assert.equal(agent.state.settings.origin, null);
});
test('all-day busy events and the day boundary prevent impossible arrival slots', async t => {
  const h = harness(t); h.day.events.push({ ...event('Unavailable', base, base + 86400000), allDay: true }); assert.equal(arrivalSlot(h.day, h.day.events[0], at(17, 25), 10), null);
  h.day.events.pop(); assert.equal(arrivalSlot(h.day, h.day.events[0], at(23, 30), 10), null);
});
test('unsafe meeting URLs cannot become join links', () => { assert.equal(safeJoinUrl('javascript:alert(1)'), null); assert.equal(safeJoinUrl('https://user:pass@example.com'), null); assert.equal(safeJoinUrl('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij'); });
