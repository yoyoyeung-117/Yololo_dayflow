import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { correlateReply, SendFailure, type Incoming } from '../server/transport.js';
import { Discord } from '../server/discord.js';
import { Zoom } from '../server/zoom.js';
import { Telegram } from '../server/telegram.js';
import { Store, defaults } from '../server/store.js';
import { conservativeReply } from '../server/llm.js';
import type { Person, Proposal, Settings } from '../shared/types.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-social-'));
  return { directory, store: new Store(directory), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function proposal(): Proposal {
  return { id: randomUUID(), code: '#DF-ABC123', mode: 'live', transport: 'social', time: '14:00', endTime: '14:30', text: 'Move to 2 pm? #DF-ABC123', createdAt: Date.now() - 5000, expiresAt: Date.now() + 60000, approvedAt: Date.now() - 2000, sentAt: Date.now() - 2000, destinationName: 'Mixed team', people: [{ id: 'a', name: 'Alex', platform: 'discord', address: '555555555555555555', messageId: '101', status: 'pending', delivery: 'sent' }, { id: 'b', name: 'Bob', platform: 'discord', address: '123456789012345678', messageId: '900000000000000001', status: 'pending', delivery: 'sent' }, { id: 'c', name: 'Sam', platform: 'zoom', address: 'sam@example.com', messageId: 'zoom-message', status: 'pending', delivery: 'sent' }], ai: false };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('reply correlation rejects wrong people, platforms, old references, unsent messages and stale timestamps', () => {
  const p = proposal();
  const event: Incoming = { platform: 'discord', sender: '555555555555555555', text: 'yes', quotedId: '101', messageId: '55:102', at: Date.now() };
  assert.equal(correlateReply(event, p)?.personId, 'a');
  assert.equal(correlateReply({ ...event, quotedId: undefined }, p), null);
  assert.equal(correlateReply({ ...event, quotedId: p.people[1].messageId }, p), null);
  assert.equal(correlateReply({ ...event, text: 'Could we do 2:15 pm?' }, p)?.text, 'Could we do 2:15 pm?');
  assert.equal(correlateReply({ ...event, text: '#DF-FFFF00 yes' }, p), null);
  assert.equal(correlateReply({ ...event, sender: '99' }, p), null);
  assert.equal(correlateReply({ ...event, platform: 'zoom' }, p), null);
  assert.equal(correlateReply({ ...event, platform: 'telegram' } as any, p), null);
  assert.equal(correlateReply({ ...event, at: p.sentAt! - 2000 }, p), null);
  assert.equal(correlateReply({ ...event, text: '#DF-ABC123 yes', quotedId: undefined }, p)?.text, 'yes');
  p.people[0].delivery = 'not_sent'; assert.equal(correlateReply(event, p), null);
});

test('Telegram ignores legacy coworker invitations and never treats private messages as coworker replies', async () => {
  const f = fixture(), actions: unknown[] = [], calls: string[] = [];
  f.store.write('telegram-invites', { old: { code: 'join_old', expiresAt: Date.now() + 60000 } });
  const tg = new Telegram(() => ({ ...defaults(), telegramOwnerChatId: '42' }), () => { throw new Error('Must not change owner'); }, f.store, async (...a) => { actions.push(a); });
  (tg as any).api = async (method: string) => { calls.push(method); return {}; };
  try {
    await (tg as any).handle({ message: { chat: { id: 55, type: 'private' }, from: { id: 55 }, text: '/start join_old' } });
    await (tg as any).handle({ message: { chat: { id: 55, type: 'private' }, from: { id: 55 }, text: '#DF-ABC123 yes' } });
    await (tg as any).handle({ callback_query: { id: 'old-button', from: { id: 55 }, data: 'reply:proposal:yes', message: { message_id: 101, chat: { id: 55, type: 'private' } } } });
    assert.equal(actions.length, 0); assert.equal(calls.includes('sendMessage'), false);
    assert.equal('sendProposal' in tg, false); assert.equal('invite' in tg, false);
  } finally { f.cleanup(); }
});

test('Discord sends only the selected mention and binds replies to the configured channel', async () => {
  const f = fixture(), calls: { url: string; body: any }[] = [];
  const settings = { ...defaults(), discordToken: 'fake', discordChannelId: '888888888888888888' };
  const p = proposal();
  const http = (async (input, init) => {
    const url = String(input); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/users/@me')) return json({ id: 'bot', username: 'DayMade', bot: true });
    if (url.endsWith('/applications/@me')) return json({ flags: 1 << 19 });
    if (url.endsWith('/channels/888888888888888888')) return json({ id: settings.discordChannelId, name: 'demo', type: 0, guild_id: 'server' });
    if (init?.method === 'POST') return json({ id: '900000000000000001', timestamp: new Date().toISOString() });
    if (url.includes('after=')) return json([{ id: '900000000000000002', author: { id: p.people[1].address }, content: 'yes', mentions: [], message_reference: { message_id: p.people[1].messageId }, timestamp: new Date().toISOString() }]);
    return json([]);
  }) as typeof fetch;
  const discord = new Discord(() => settings, f.store, http);
  try {
    await discord.check(); assert.equal(discord.connected, true);
    const receipt = await discord.sendProposal(p.people[1], p); assert.equal(receipt.delivery, 'sent');
    const send = calls.find(c => c.body)!;
    assert.deepEqual(send.body.allowed_mentions, { parse: [], users: [p.people[1].address], replied_user: false });
    const events: Incoming[] = []; await discord.poll(p, async event => { events.push(event); });
    assert.equal(events.length, 1); assert.equal(correlateReply(events[0], p)?.personId, 'b');
    assert.equal(correlateReply(events[0], p)?.text, 'yes');
    assert.ok(calls.every(call => call.url.includes('/users/@me') || call.url.includes('/applications/@me') || call.url.includes(settings.discordChannelId)));
  } finally { f.cleanup(); }
});

test('Discord enables unmentioned reply content and preserves existing editable intents', async () => {
  const f = fixture(), calls: { method: string; body: any }[] = [];
  const existing = (1 << 13) | (1 << 15) | (1 << 23);
  const enabled = (1 << 13) | (1 << 15) | (1 << 19);
  const discord = new Discord(() => ({ ...defaults(), discordToken: 'fake', discordChannelId: '888888888888888888' }), f.store, (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/users/@me')) return json({ id: 'bot', username: 'DayMade', bot: true });
    if (url.endsWith('/channels/888888888888888888')) return json({ id: '888888888888888888', name: 'demo', type: 0, guild_id: 'server' });
    if (url.endsWith('/applications/@me')) {
      calls.push({ method: init!.method!, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json({ flags: init?.method === 'PATCH' ? enabled : existing });
    }
    return json([]);
  }) as typeof fetch);
  try {
    await discord.check();
    assert.equal(discord.connected, true);
    assert.deepEqual(calls, [{ method: 'GET', body: undefined }, { method: 'PATCH', body: { flags: enabled } }]);
  } finally { f.cleanup(); }
});

test('Discord accepts either content intent flag without changing application settings', async () => {
  for (const flags of [1 << 18, 1 << 19]) {
    const f = fixture();
    const discord = new Discord(() => ({ ...defaults(), discordToken: 'fake', discordChannelId: '888888888888888888' }), f.store, (async (input, init) => {
      assert.equal(init?.method, 'GET');
      const url = String(input);
      if (url.endsWith('/users/@me')) return json({ id: 'bot', username: 'DayMade', bot: true });
      if (url.endsWith('/applications/@me')) return json({ flags });
      if (url.endsWith('/channels/888888888888888888')) return json({ id: '888888888888888888', name: 'demo', type: 0, guild_id: 'server' });
      return json([]);
    }) as typeof fetch);
    try { await discord.check(); assert.equal(discord.connected, true); }
    finally { f.cleanup(); }
  }
});

test('Discord does not report readiness when unmentioned reply content cannot be enabled', async () => {
  for (const status of [200, 403, 429]) {
    const f = fixture();
    const discord = new Discord(() => ({ ...defaults(), discordToken: 'fake', discordChannelId: '888888888888888888' }), f.store, (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/users/@me')) return json({ id: 'bot', username: 'DayMade', bot: true });
      if (url.endsWith('/applications/@me')) return json({ flags: 0 }, init?.method === 'PATCH' ? status : 200);
      if (url.endsWith('/channels/888888888888888888')) return json({ id: '888888888888888888', name: 'demo', type: 0, guild_id: 'server' });
      return json([]);
    }) as typeof fetch);
    try {
      discord.connected = true;
      await assert.rejects(discord.check(), /Message Content Intent/);
      assert.equal(discord.connected, false);
      assert.match(discord.error!, /reconnect/);
    } finally { f.cleanup(); }
  }
});

test('Discord rate limits stop sending without automatic retries', async () => {
  const f = fixture(); let calls = 0;
  const discord = new Discord(() => ({ ...defaults(), discordToken: 'fake', discordChannelId: '123456789012345678' }), f.store, (async () => { calls++; return json({ retry_after: 30 }, 429); }) as typeof fetch);
  discord.connected = true; const p = proposal();
  try {
    await assert.rejects(discord.sendProposal(p.people[1], p), e => e instanceof SendFailure && e.definitive);
    await assert.rejects(discord.sendProposal(p.people[1], p), /cooling down/); assert.equal(calls, 1);
  } finally { f.cleanup(); }
});

test('Zoom OAuth state is single-use, tokens stay in storage, and send/receive use the authorized contact', async () => {
  const f = fixture(), calls: { url: string; init?: RequestInit }[] = [];
  const settings = { ...defaults(), zoomClientId: 'client', zoomClientSecret: 'secret', zoomRedirectBaseUrl: 'https://demo.example' };
  const p = proposal();
  const http = (async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/oauth/token')) return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    if (url.endsWith('/users/me')) return json({ id: 'owner', email: 'owner@example.com' });
    if (init?.method === 'POST') return json({ id: 'zoom-message' });
    return json({ messages: [{ id: 'reply', sender: 'sam@example.com', message: '#DF-ABC123 yes', timestamp: Date.now() }, { id: 'outgoing', sender: 'owner@example.com', message: '#DF-ABC123 yes', timestamp: Date.now() }, { id: 'unknown', message: '#DF-ABC123 yes', timestamp: Date.now() }] });
  }) as typeof fetch;
  const zoom = new Zoom(() => settings, f.store, http);
  try {
    const url = new URL(zoom.authorizeUrl()); assert.equal(url.searchParams.get('redirect_uri'), 'https://demo.example/oauth/zoom/callback');
    await assert.rejects(zoom.callback('code', 'bad-state'), /does not match/); assert.equal(calls.length, 0);
    await zoom.callback('code', url.searchParams.get('state')!); assert.equal(zoom.account, 'owner@example.com');
    await assert.rejects(zoom.callback('code', url.searchParams.get('state')!), /does not match/);
    const receipt = await zoom.sendProposal(p.people[2], p); assert.equal(receipt.delivery, 'sent');
    const send = calls.find(c => c.url.endsWith('/chat/users/me/messages') && c.init?.method === 'POST')!;
    assert.equal(JSON.parse(String(send.init!.body)).to_contact, 'sam@example.com');
    const events: Incoming[] = []; await zoom.poll(p, async e => { events.push(e); });
    assert.equal(events.length, 1); assert.equal(correlateReply(events[0], p)?.personId, 'c');
    assert.equal((f.store.read<any>('zoom-tokens', {})).refreshToken, 'refresh');
  } finally { f.cleanup(); }
});

test('Zoom refreshes an expired token once for concurrent requests', async () => {
  const f = fixture(); let refreshes = 0;
  f.store.write('zoom-tokens', { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, clientId: 'client', account: 'owner@example.com', userId: 'owner' });
  const zoom = new Zoom(() => ({ ...defaults(), zoomClientId: 'client', zoomClientSecret: 'secret' }), f.store, (async input => {
    if (String(input).includes('/oauth/token')) { refreshes++; await new Promise(r => setTimeout(r, 5)); return json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }); }
    return json({ id: 'owner', email: 'owner@example.com' });
  }) as typeof fetch);
  try { await Promise.all([zoom.check(), zoom.check()]); assert.equal(refreshes, 1); assert.equal(f.store.read<any>('zoom-tokens', {}).refreshToken, 'rotated'); }
  finally { f.cleanup(); }
});

test('owner approval routes coworker messages only to Discord and Zoom and reports back on Telegram', async () => {
  const f = fixture();
  const settings: Settings = { ...defaults(), telegramToken: '123:fake', telegramOwnerChatId: '42', discordToken: 'fake', discordChannelId: '888888888888888888', coworkers: [
    { id: randomUUID(), name: 'Alex', platform: 'discord', address: '555555555555555555', enabled: true },
    { id: randomUUID(), name: 'Bob', platform: 'discord', address: '123456789012345678', enabled: true },
    { id: randomUUID(), name: 'Sam', platform: 'zoom', address: 'sam@example.com', enabled: true },
  ] };
  f.store.write('settings', settings);
  const service = createApp(f.directory), sends: string[] = [];
  service.telegram.connected = true; service.discord.connected = true; service.discord.channelName = 'demo'; service.zoom.connected = true;
  service.model.opening = async () => ({ text: 'I am running behind.', ai: false });
  service.model.interpret = async text => ({ ...conservativeReply(text), ai: false });
  service.telegram.send = async () => {};
  service.zoom.checkContact = async () => {};
  const sender = (platform: string) => async (person: Person) => { sends.push(`${platform}:${person.address}`); return { id: `${platform}-receipt`, createdDateTime: new Date().toISOString(), delivery: 'sent' as const }; };
  service.discord.sendProposal = sender('discord'); service.zoom.sendProposal = sender('zoom');
  try {
    service.engine.reset('live'); await service.engine.advance(); const p = service.engine.state.proposal!;
    assert.equal(sends.length, 0); assert.match(p.destinationName, /Discord \+ Zoom/);
    assert.equal(p.people.some(p => (p.platform as string) === 'telegram'), false);
    await service.engine.approve(p.id); assert.deepEqual(sends, ['discord:555555555555555555', 'discord:123456789012345678', 'zoom:sam@example.com']);
    for (const person of p.people) await service.inbox.receive({ platform: person.platform!, sender: person.address!, text: person.platform === 'discord' ? 'yes' : `${p.code} yes`, quotedId: person.platform === 'discord' ? person.messageId : undefined, messageId: person.id, at: Date.now() });
    // Verify the incoming responses were persisted before model interpretation.
    assert.equal(f.store.read<any[]>('social-inbox', []).length, 3);
    await service.inbox.drain(); assert.equal(service.engine.state.phase, 'agreed');
    assert.equal(service.engine.state.processedMessages.length, 3);
    await service.inbox.receive({ platform: 'discord', sender: '555555555555555555', text: `${p.code} no`, messageId: p.people[0].id, at: Date.now() });
    await service.inbox.drain(); assert.equal(service.engine.state.phase, 'agreed');
  } finally { f.cleanup(); }
});

test('an unused Zoom connection does not block Discord coworkers with Telegram owner approval', async () => {
  const f = fixture(); f.store.write('settings', { ...defaults(), telegramToken: '123:fake', telegramOwnerChatId: '42', coworkers: [{ id: randomUUID(), name: 'Alex', platform: 'discord', address: '555555555555555555', enabled: true }, { id: randomUUID(), name: 'Sam', platform: 'zoom', address: '', enabled: false }] });
  const s = createApp(f.directory); s.telegram.connected = true; s.discord.connected = true; s.discord.channelName = 'demo'; s.telegram.send = async () => {}; s.model.opening = async () => ({ text: 'Running behind.', ai: false });
  try { s.engine.reset('live'); await s.engine.advance(); assert.equal(s.engine.state.proposal!.people.length, 1); assert.equal(s.engine.state.proposal!.people[0].platform, 'discord'); }
  finally { f.cleanup(); }
});

test('migration preserves owner pairing and model, strips old credentials, and keeps OAuth callback isolated', async () => {
  const f = fixture(); f.store.write('settings', { ...defaults(), telegramToken: '123:fake', telegramOwnerChatId: '42', discordToken: 'discord-secret', zoomClientSecret: 'zoom-secret', twilioAuthToken: 'obsolete', ollamaModel: 'qwen3:4b', coworkers: [{ id: randomUUID(), name: 'Old Telegram participant', platform: 'telegram', address: '55', enabled: true }] });
  const s = createApp(f.directory), server = s.app.listen(0, '127.0.0.1'), publicServer = s.webhookApp.listen(0, '127.0.0.1');
  await Promise.all([new Promise<void>(r => server.once('listening', r)), new Promise<void>(r => publicServer.once('listening', r))]);
  const base = `http://127.0.0.1:${(server.address() as any).port}`, publicBase = `http://127.0.0.1:${(publicServer.address() as any).port}`;
  try {
    const snapshot = await fetch(`${base}/api/state`).then(r => r.json()) as any;
    for (const key of ['telegramToken', 'discordToken', 'zoomClientSecret', 'twilioAuthToken']) assert.equal(key in snapshot.settings, false);
    assert.equal(snapshot.settings.coworkers.length, 0);
    assert.equal(f.store.read<any[]>('coworkers-before-owner-only-telegram', []).length, 1);
    assert.equal(snapshot.settings.telegramOwnerChatId, '42'); assert.equal(snapshot.settings.ollamaModel, 'qwen3:4b');
    const invalidCoworker = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coworkers: [{ id: randomUUID(), name: 'Wrong platform', platform: 'telegram', address: '55', enabled: true }] }) });
    assert.equal(invalidCoworker.status, 400);
    assert.equal((await fetch(`${base}/api/telegram/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await fetch(`${publicBase}/api/state`)).status, 404);
    assert.equal((await fetch(`${publicBase}/oauth/zoom/callback?code=fake&state=forged`)).status, 400);
    assert.equal((await fetch(`${publicBase}/`)).status, 404);
    assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramOwnerChatId: '99' }) })).status, 400);
  } finally { server.closeAllConnections(); publicServer.closeAllConnections(); await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => publicServer.close(() => r()))]); f.cleanup(); }
});

test('Discord listens without a proposal, uses a durable cursor, and retries intake only before acknowledgement', async () => {
  const f = fixture(), since = Date.now() - 1000, floor = BigInt(since - 1420070400000) << 22n;
  const calls: string[] = [], events: Incoming[] = [];
  const messages = [1n, 2n].map(n => ({ id: String(floor + n), content: 'Move Coffee from 17:00 to 17:30', author: { id: '123456789012345678' }, timestamp: new Date(since + 100).toISOString() }));
  const http = (async input => { const url = new URL(String(input)); calls.push(String(input)); const after = BigInt(url.searchParams.get('after')!); return json(messages.filter(m => BigInt(m.id) > after)); }) as typeof fetch;
  const make = () => { const d = new Discord(() => ({ ...defaults(), discordToken: 'fake', discordChannelId: '888888888888888888' }), f.store, http); d.connected = true; return d; };
  try {
    const d = make(); let fail = true;
    await d.pollRequests(since, async event => { if (fail) { fail = false; throw new Error('storage unavailable'); } events.push(event); });
    assert.match(d.error!, /storage/); assert.equal(events.length, 0);
    await d.pollRequests(since, async e => { events.push(e); }); assert.equal(events.length, 2);
    await make().pollRequests(since, async e => { events.push(e); }); assert.equal(events.length, 2);
    assert.ok(calls[0].includes(`after=${floor}`)); d.invalidate(); const count = calls.length; await d.pollRequests(since, async () => {}); assert.equal(calls.length, count);
  } finally { f.cleanup(); }
});

test('Zoom accepts teammate initiation only from the saved contact and pauses without erasing OAuth tokens', async () => {
  const f = fixture(), since = Date.now() - 2000, events: Incoming[] = [];
  f.store.write('zoom-tokens', { accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, clientId: 'client', account: 'owner@example.com', userId: 'owner' });
  const zoom = new Zoom(() => ({ ...defaults(), zoomClientId: 'client', zoomClientSecret: 'fake' }), f.store, (async () => json({ messages: [
    { id: 'peer', sender: 'sam@example.com', message: 'Move Coffee to 17:30', timestamp: since + 1000 },
    { id: 'owner', sender: 'owner@example.com', message: 'Move Coffee to 17:30', timestamp: since + 1000 },
  ] })) as typeof fetch);
  zoom.connected = true;
  try {
    await zoom.pollRequests(since, [{ id: 'sam', name: 'Sam', platform: 'zoom', address: 'sam@example.com', enabled: true }], async e => { events.push(e); });
    assert.deepEqual(events.map(e => e.messageId), ['peer']); zoom.disconnect(); assert.equal(zoom.connected, false); assert.ok(f.store.read('zoom-tokens', null));
  } finally { f.cleanup(); }
});
