import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CalendarAgent } from '../server/calendar.js';
import { requestIntent, requestSlot, TeammateRequests } from '../server/requests.js';
import { Store } from '../server/store.js';
import { conservativeReply } from '../server/llm.js';
import type { CalendarDay, CalendarEvent } from '../shared/calendar.js';
import type { Coworker } from '../shared/types.js';
import type { Incoming } from '../server/transport.js';
const base = Date.UTC(2026, 8, 11, 16), at = (h: number, m = 0) => base + (h * 60 + m) * 60000;
const event = (title: string, start: number, end: number): CalendarEvent => ({ id: title, eventIdentifier: title, calendarId: 'personal', calendarName: 'iCloud', title, start, end, editable: true, allDay: false, hasAttendees: false, recurring: false, location: '', modified: 0, busy: true });
function harness(t: { after: (fn: () => void) => void }, two = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-requests-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = at(15), saves = 0, occupied = false, failSend = false, destination = 'channel';
  const people: Coworker[] = [{ id: 'alex', name: 'Alex', address: '111111111111111111', platform: 'discord', enabled: true }, ...(two ? [{ id: 'sam', name: 'Sam', address: '222222222222222222', platform: 'discord' as const, enabled: true }] : [])];
  const day: CalendarDay = { day: '2026-09-12', dayStart: base, dayEnd: base + 86400000, timezone: 'Asia/Hong_Kong', revision: 'first', events: [event('Coffee', at(17), at(17, 30))], calendars: [] };
  const notices: { text: string; buttons?: any }[] = [], sends: { person: string; text: string }[] = [];
  const store = new Store(dir);
  const calendar = new CalendarAgent(store, { read: async () => structuredClone(day), apply: async plan => {
    saves++; const receipts = plan.changes.map(c => ({ id: c.event.id, start: c.start, end: c.end }));
    for (const change of plan.changes) { const e = day.events.find(e => e.id === change.event.id)!; e.start = change.start; e.end = change.end; e.id += '@moved'; }
    day.revision = 'saved'; return receipts;
  } }, {
    now: () => now, opening: async () => ({ text: '', ai: false }), interpret: async (text, time) => ({ ...conservativeReply(text, time), ai: false }),
    destination: async ids => ({ destinationId: 'channel', destinationName: 'Discord', people: people.filter(p => ids?.includes(p.id)).map(p => ({ ...p })) }),
    send: async (person, proposal) => { sends.push({ person: person.id, text: proposal.text }); if (failSend) throw new Error('uncertain'); return { id: `message-${sends.length}`, createdDateTime: new Date(now).toISOString() }; },
    notify: async text => { notices.push({ text }); },
  }, async (text, buttons) => { notices.push({ text, buttons }); }, () => occupied, () => now);
  calendar.state.rules.Coffee = { flexible: true, personIds: people.map(p => p.id) };
  calendar.state.connected = true;
  const make = () => new TeammateRequests(store, calendar, () => people, () => occupied, async (text, buttons) => { notices.push({ text, buttons }); }, async (person, text) => { sends.push({ person: person.id, text }); }, () => now, () => destination);
  const requests = make();
  const receive = (text = 'Can we move Coffee from 17:00 to 17:30?', extra: Partial<Incoming> = {}) => requests.receive({ platform: 'discord', sender: people[0].address, messageId: 'request-1', at: now, text, ...extra });
  return { requests, calendar, receive, day, people, sends, notices, make, saves: () => saves, clock: (value: number) => { now = value; }, occupy: (value: boolean) => { occupied = value; }, fail: () => { failSend = true; }, changeDestination: () => { destination = 'other-channel'; } };
}
test('teammate initiates: free slot asks owner; acceptance counts requester consent, waits for others, saves and confirms both ways', async t => {
  const h = harness(t); await h.receive(); await h.requests.tick();
  const r = h.requests.state.requests[0]; assert.equal(r.status, 'awaiting_owner'); assert.equal(h.sends.length, 0); assert.equal(h.saves(), 0);
  assert.match(h.notices[0].text, /Calendar says you’re free/); assert.match(h.notices[0].buttons[0][0].callback_data, /^peerapprove:/);
  await h.requests.action(r.id, 'accept'); assert.equal(r.status, 'coordinating'); assert.equal(h.sends.length, 2); assert.equal(h.saves(), 0);
  const engine = h.calendar.conversations[0].engine, p = engine.state.proposal!;
  assert.equal(p.people[0].status, 'accepted'); assert.equal(p.people[1].status, 'pending');
  await h.calendar.conversations[0].inbox.receive({ platform: 'discord', sender: h.people[1].address, messageId: 'answer', text: 'For sure!', quotedId: p.people[1].messageId, at: at(15) });
  await h.calendar.tick(); await h.requests.tick();
  assert.equal(h.saves(), 1); assert.equal(r.status, 'completed'); assert.equal(r.selectedTime, '17:30');
  assert.equal(h.sends.filter(m => m.text.startsWith('Confirmed:')).length, 2); assert.match(h.notices.find(n => n.text.includes('Calendar updated'))!.text, /17:30–18:00/);
  assert.deepEqual(h.calendar.state.rules['Coffee@moved'].personIds, ['alex', 'sam']);
  await assert.rejects(h.requests.action(r.id, 'accept'), /already been handled/); await h.calendar.tick(); assert.equal(h.saves(), 1);
});
test('owner can counter earlier from Telegram; a different time requires everyone to agree again', async t => {
  const h = harness(t); await h.receive(); await h.requests.tick(); const r = h.requests.state.requests[0];
  await h.requests.action(r.id, 'accept', '16:30');
  assert.equal(h.calendar.state.plan!.changes[0].start, at(16, 30));
  assert.ok(h.calendar.conversations[0].engine.state.proposal!.people.every(p => p.status === 'pending')); assert.equal(h.saves(), 0);
});
test('busy request is automatically countered without owner approval and without disclosing private event details', async t => {
  const h = harness(t); h.day.events.push(event('Private medical appointment', at(16), at(16, 45)));
  await h.receive('Move Coffee from 17:00 to 16:30'); await h.requests.tick();
  assert.equal(h.requests.state.requests[0].status, 'coordinating'); assert.equal(h.calendar.state.plan!.changes[0].start, at(16, 55));
  assert.equal(h.sends.length, 2); assert.ok(h.sends.every(s => /16:30 time is unavailable/.test(s.text) && !s.text.includes('medical')));
  assert.ok(h.calendar.conversations[0].engine.state.proposal!.people.every(p => p.status === 'pending')); assert.equal(h.saves(), 0);
});
test('a decline during teammate coordination checks Calendar and proposes the next free time automatically', async t => {
  const h = harness(t); await h.receive(); await h.requests.tick(); await h.requests.action(h.requests.state.requests[0].id, 'accept');
  const e = h.calendar.conversations[0].engine;
  await e.reply(e.state.proposal!.id, 'sam', 'how about 18:00?', 'counter'); await h.calendar.tick();
  assert.equal(e.state.proposal!.time, '18:00'); assert.equal(e.state.proposal!.negotiation!.round, 2);
  assert.ok(e.state.proposal!.people.every(p => p.status === 'pending')); assert.equal(h.saves(), 0); assert.equal(h.sends.length, 4);
});
test('one requester needs no duplicate confirmation after owner accepts exact requested time', async t => {
  const h = harness(t, false); await h.receive(); await h.requests.tick(); await h.requests.action(h.requests.state.requests[0].id, 'accept');
  assert.equal(h.saves(), 1); assert.equal(h.requests.state.requests[0].status, 'completed');
  assert.ok(!h.notices.at(-1)!.text.includes('coordinating 17:30'));
});
test('unknown senders, historical messages, proposal replies and duplicate delivery cannot initiate requests', async t => {
  const h = harness(t); await h.receive(undefined, { sender: 'stranger' }); await h.receive(undefined, { at: at(14) }); await h.receive('#DF-ABC123 how about 17:30?');
  assert.equal(h.requests.state.requests.length, 0); await h.receive(); await h.receive(); assert.equal(h.requests.state.requests.length, 1);
});
test('ambiguous meeting, mismatched source and unsafe or invalid times cannot trigger coordination', async t => {
  const h = harness(t); const rules = h.calendar.state.rules;
  for (const text of ["Don't move Coffee to 17:30", 'Do not change Coffee to 17:30', 'Move Coffee from 18:00 to 17:30', 'Move Coffee to 25:00', 'Move Coffee to 17:99', 'Move Coffee tomorrow to 17:30', 'If everyone agrees move Coffee to 17:30']) {
    const intent = requestIntent(text, h.day.events, rules, 'alex', h.day.timezone, at(15)); assert.ok(!intent || intent.ambiguous, text);
  }
  h.day.events.push(event('Dinner', at(19), at(20))); rules.Dinner = { flexible: true, personIds: ['alex'] };
  assert.equal(requestIntent('How about 17:30?', h.day.events, rules, 'alex', h.day.timezone, at(15))?.ambiguous, true);
  await h.receive('How about 17:30?'); await h.requests.tick(); assert.equal(h.calendar.state.plan, null); assert.equal(h.saves(), 0); assert.match(h.sends[0].text, /could not identify/);
});
test('calendar changes, changed recipients and expired owner cards cannot authorize a send', async t => {
  const h = harness(t); await h.receive(); await h.requests.tick(); const id = h.requests.state.requests[0].id;
  h.day.events[0].title = 'Edited'; await assert.rejects(h.requests.action(id, 'accept'), /changed outside/); h.day.events[0].title = 'Coffee';
  h.people[1].address = '333333333333333333'; await assert.rejects(h.requests.action(id, 'accept'), /participants changed/);
  assert.equal(h.sends.length, 0); h.clock(at(15, 11)); await assert.rejects(h.requests.action(id, 'accept'), /expired/);
});
test('owner rejection stays in Telegram and notifies the teammate without changing Calendar', async t => {
  const h = harness(t); await h.receive(); await h.requests.tick(); await h.requests.action(h.requests.state.requests[0].id, 'reject');
  assert.equal(h.requests.state.requests[0].status, 'declined'); assert.equal(h.saves(), 0); assert.equal(h.sends.length, 1); assert.match(h.sends[0].text, /owner declined/);
});
test('paused monitoring invalidates cards, persists across restart, and ignores messages from the pause', async t => {
  const h = harness(t); await h.receive(); await h.requests.tick(); const r = h.requests.state.requests[0]; h.requests.configure(false);
  assert.equal(h.make().state.enabled, false); await assert.rejects(h.requests.action(r.id, 'accept'), /expired/);
  await h.receive(undefined, { messageId: 'paused' }); assert.equal(h.requests.state.requests.length, 1);
  h.clock(at(15, 2)); h.requests.configure(true); await h.receive(undefined, { at: at(15, 1), messageId: 'during-pause' }); assert.equal(h.requests.state.requests.length, 1);
});
test('requests queue while another conversation runs and uncertain delivery is never retried', async t => {
  const h = harness(t); h.occupy(true); await h.receive(); await h.requests.tick(); assert.equal(h.requests.state.requests[0].status, 'queued');
  h.occupy(false); await h.requests.tick(); h.fail(); await h.requests.action(h.requests.state.requests[0].id, 'accept');
  assert.equal(h.requests.state.requests[0].status, 'unresolved'); await h.requests.tick(); await h.calendar.tick(); assert.equal(h.sends.length, 1); assert.equal(h.saves(), 0);
});
test('all-day busy events and day boundaries prevent unsafe automatic alternatives', async t => {
  const h = harness(t); const allDay = event('Away', base, base + 86400000); allDay.allDay = true; h.day.events.push(allDay);
  assert.deepEqual(requestSlot(h.day, h.day.events[0], '17:30', at(15)), { start: null, busy: true });
  h.day.events.pop(); assert.deepEqual(requestSlot(h.day, h.day.events[0], '23:45', at(15)), { start: null, busy: true });
  await assert.rejects(h.requests.action('missing', 'accept'), /expired/);
});

test('Calendar is checked again at preparation so a changed event or all-day conflict cannot slip through', async t => {
  const h = harness(t); const original = structuredClone(h.day.events[0]);
  const origin = { requestId: 'r', requesterId: 'alex', requestedTime: '17:30', originalText: 'Move Coffee to 17:30', sourceMessageId: 'm', reason: 'Requested by Alex' };
  h.day.events[0].end += 60000;
  await assert.rejects(h.calendar.preparePeerChange('Coffee', at(17, 30), origin, 10, original), /changed outside/);
  h.day.events[0] = original; const away = event('Away', base, base + 86400000); away.allDay = true; h.day.events.push(away);
  await assert.rejects(h.calendar.preparePeerChange('Coffee', at(17, 30), origin, 10, original), /busy/);
  assert.equal(h.sends.length, 0); assert.equal(h.saves(), 0);
});

test('changing a chat destination invalidates a waiting owner card', async t => {
  const h = harness(t); await h.receive(); await h.requests.tick(); h.changeDestination();
  await assert.rejects(h.requests.action(h.requests.state.requests[0].id, 'accept'), /destination changed/);
  assert.equal(h.sends.length, 0); assert.equal(h.saves(), 0);
});
