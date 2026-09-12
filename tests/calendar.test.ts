import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planDay } from '../server/day-planner.js';
import { CalendarAgent } from '../server/calendar.js';
import { Store } from '../server/store.js';
import { conservativeReply } from '../server/llm.js';
import type { CalendarDay, CalendarEvent, EventRule } from '../shared/calendar.js';
const base = Date.UTC(2026, 8, 12), at = (h: number, m = 0) => base + (h * 60 + m) * 60000;
const event = (id: string, start: number, end: number, editable = true): CalendarEvent => ({ id, eventIdentifier: id, calendarId: 'icloud', calendarName: 'Personal', title: id, start, end, editable, allDay: false, hasAttendees: false, recurring: false, location: '', modified: 1, busy: true });
const fixture = (): CalendarDay => ({ day: '2026-09-12', dayStart: base, dayEnd: base + 86400000, timezone: 'UTC', revision: 'version-1', events: [event('Lunch', at(12), at(13)), event('Friends', at(13, 30), at(14)), event('Study', at(14, 10), at(15)), event('Dinner', at(19), at(20))], calendars: [{ id: 'icloud', name: 'Personal', source: 'iCloud', writable: true }] });
const rules: Record<string, EventRule> = { Friends: { flexible: true, personIds: ['alex'] }, Study: { flexible: true, personIds: [] } };

test('whole-day ripple preserves durations, absorbs delay in later gaps, and never edits source', () => {
  const day = fixture(), original = structuredClone(day);
  const p = planDay(day, rules, 'Lunch', 30, 10, at(13, 15));
  assert.deepEqual(p.changes.map(c => [c.event.id, c.start, c.end]), [['Friends', at(13, 55), at(14, 25)], ['Study', at(14, 35), at(15, 25)]]);
  assert.deepEqual(p.blockers, []); assert.deepEqual(day, original);
});
test('fixed anchors move flexible appointments into the next available gap', () => {
  const day = fixture(); day.events.push(event('Fixed call', at(14), at(15), false));
  const p = planDay(day, rules, 'Lunch', 30, 10, at(13, 15));
  assert.equal(p.changes[0].start, at(15, 10)); assert.equal(p.changes[1].start, at(15, 50));
  assert.ok(!p.changes.some(c => c.event.id === 'Fixed call'));
});
test('overrun into a fixed event blocks approval; read-only cannot be made movable by a rule', () => {
  const day = fixture(); day.events[1].editable = false;
  const p = planDay(day, rules, 'Lunch', 30, 10, at(13, 15));
  assert.match(p.blockers.join(), /Friends.*fixed/); assert.ok(!p.changes.some(c => c.event.id === 'Friends'));
});
test('no changes when the day has enough slack; rejects future source and past-day overflow', () => {
  const day = fixture(); assert.equal(planDay(day, rules, 'Lunch', 5, 5, at(13)).changes.length, 0);
  assert.throws(() => planDay(day, rules, 'Dinner', 15, 10, at(13)), /ongoing/);
  day.dayEnd = at(14, 45); assert.match(planDay(day, rules, 'Lunch', 30, 10, at(13, 15)).blockers.join(), /midnight/);
});
function harness(t: { after: (fn: () => void) => void }, options: { socialStudy?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-calendar-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let day = fixture(), clock = at(13, 15), saves = 0, sends = 0, failSend = false, failSave = false, destination = 'discord-channel';
  const notices: { text: string; buttons?: any }[] = [];
  const make = () => new CalendarAgent(new Store(directory), { read: async () => structuredClone(day), apply: async plan => { saves++; if (failSave) throw new Error('timeout'); return plan.changes.map(c => ({ id: c.event.id, start: c.start, end: c.end })); } }, {
    now: () => clock, opening: async () => ({ text: '', ai: false }), interpret: async text => ({ ...conservativeReply(text), ai: false }),
    destination: async ids => ({ destinationId: destination, destinationName: 'Discord · #friends', people: (ids || []).map(id => ({ id, name: id, platform: 'discord', address: id === 'alex' ? '123456789012345678' : '223456789012345678' })) }),
    send: async () => { sends++; if (failSend) throw new Error('send timeout'); return { id: `sent-${sends}`, createdDateTime: new Date(clock).toISOString() }; }, notify: async text => { notices.push({ text }); },
  }, async (text, buttons) => { notices.push({ text, buttons }); }, () => false, () => clock);
  const agent = make(); agent.state.rules = structuredClone(rules); if (options.socialStudy) agent.state.rules.Study.personIds = ['sam'];
  return { agent, make, notices, sends: () => sends, saves: () => saves, changeCalendar: () => { day.revision = 'version-2'; }, changeDestination: () => { destination = 'new-channel'; }, setClock: (n: number) => { clock = n; }, failSend: () => { failSend = true; }, failSave: () => { failSave = true; } };
}
test('calendar plan sends only after approval, tracks each meeting independently, and saves only after all agree', async t => {
  const h = harness(t, { socialStudy: true }); const p = await h.agent.preview('Lunch', 30, 10);
  assert.equal(h.sends(), 0); assert.equal(h.saves(), 0); assert.equal(h.agent.conversations.length, 2);
  assert.match(h.agent.conversations[0].engine.state.proposal!.text, /2026-09-12.*13:30–14:00 to 13:55–14:25/);
  assert.match(h.notices.at(-1)!.buttons[0][0].callback_data, /^dayapprove:/);
  const approvals = await Promise.allSettled([h.agent.approve(p.id), h.agent.approve(p.id)]);
  assert.equal(approvals.filter(a => a.status === 'fulfilled').length, 1); assert.equal(h.sends(), 2); assert.equal(h.saves(), 0);
  const [a, b] = h.agent.conversations;
  await a.engine.reply(a.engine.state.proposal!.id, 'alex', 'yes', 'reply-a'); await h.agent.tick(); assert.equal(h.saves(), 0);
  await b.engine.reply(b.engine.state.proposal!.id, 'sam', 'yes', 'reply-b'); await h.agent.tick();
  assert.equal(h.saves(), 1); assert.equal(p.status, 'applied'); assert.equal(p.receipts!.length, 2);
  await h.agent.tick(); assert.equal(h.saves(), 1);
});
test('stale calendar, changed destinations and expired approval cannot send', async t => {
  const h = harness(t); const p = await h.agent.preview('Lunch', 30, 10); h.changeCalendar(); await assert.rejects(h.agent.approve(p.id), /Calendar changed/); assert.equal(h.sends(), 0);
  const fresh = await h.agent.preview('Lunch', 30, 10); h.changeDestination(); await assert.rejects(h.agent.approve(fresh.id), /destination changed/); assert.equal(h.sends(), 0);
  h.setClock(at(13, 26)); await assert.rejects(h.agent.approve(fresh.id), /expired/);
});
test('calendar changed during coordination never writes even after acceptance', async t => {
  const h = harness(t); const p = await h.agent.preview('Lunch', 30, 10); await h.agent.approve(p.id); h.changeCalendar();
  const e = h.agent.conversations[0].engine; await e.reply(e.state.proposal!.id, 'alex', 'yes', 'reply'); await h.agent.tick();
  assert.equal(h.saves(), 0); assert.equal(p.status, 'attention');
});
test('declines, silence and unknown replies cannot authorize calendar writes', async t => {
  const h = harness(t); const p = await h.agent.preview('Lunch', 30, 10); await h.agent.approve(p.id);
  const e = h.agent.conversations[0].engine; await e.reply(e.state.proposal!.id, 'unknown', 'yes', 'bad'); await h.agent.tick(); assert.equal(h.saves(), 0);
  await e.reply(e.state.proposal!.id, 'alex', 'no', 'reply'); await h.agent.tick(); assert.equal(p.status, 'attention'); assert.equal(h.saves(), 0);
});
test('partial delivery and uncertain calendar saves are never retried', async t => {
  const h = harness(t); const p = await h.agent.preview('Lunch', 30, 10); h.failSend(); await h.agent.approve(p.id); await h.agent.tick(); assert.equal(h.sends(), 1); assert.equal(h.saves(), 0); assert.equal(p.status, 'attention');
  const other = harness(t); const q = await other.agent.preview('Lunch', 30, 10); await other.agent.approve(q.id); other.failSave(); const e = other.agent.conversations[0].engine; await e.reply(e.state.proposal!.id, 'alex', 'yes', 'reply'); await other.agent.tick(); await other.agent.tick(); assert.equal(other.saves(), 1); assert.equal(q.status, 'uncertain');
});
test('personal-only plan writes after approval; restart during coordination pauses without resending', async t => {
  const h = harness(t); h.agent.state.rules.Friends.personIds = []; const p = await h.agent.preview('Lunch', 30, 10); assert.equal(h.saves(), 0); await h.agent.approve(p.id); assert.equal(h.sends(), 0); assert.equal(h.saves(), 1);
  const other = harness(t); const q = await other.agent.preview('Lunch', 30, 10); await other.agent.approve(q.id); const restarted = other.make(); await restarted.tick(); assert.equal(restarted.state.plan!.status, 'attention'); assert.equal(other.sends(), 1); assert.equal(other.saves(), 0);
});
test('monitoring sends one end check-in and requires an overrun answer before proposing', async t => {
  const h = harness(t); h.setClock(at(12, 59)); await h.agent.refresh(); h.agent.configure(true); h.setClock(at(13, 1)); await h.agent.tick();
  assert.equal(h.agent.state.plan, null); assert.equal(h.sends(), 0); assert.match(h.notices.at(-1)!.text, /Still at/);
  await h.agent.tick(); assert.equal(h.notices.length, 1);
  const callback = h.notices[0].buttons[1][0].callback_data.split(':'); await h.agent.action(callback[0], callback[1], callback[2]);
  assert.ok(h.agent.state.plan); assert.equal(h.sends(), 0);
  await assert.rejects(h.agent.action(callback[0], callback[1], callback[2]), /already answered/);
});

test('an expired review does not permanently suppress later event check-ins', async t => {
  const h = harness(t); h.setClock(at(12, 59)); await h.agent.refresh(); h.agent.configure(true);
  const p = await h.agent.preview('Lunch', 30, 10); h.setClock(at(14, 1)); await h.agent.tick();
  assert.equal(p.status, 'dismissed'); assert.match(h.notices.at(-1)!.text, /Still at.*Friends/);
});
