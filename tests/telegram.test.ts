import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telegram } from '../server/telegram.js';
import { defaults, Store } from '../server/store.js';
import type { Proposal } from '../shared/types.js';

test('Telegram callbacks accept only the paired owner and carry the proposal ID and chosen time', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-telegram-'));
  const actions: unknown[] = [], calls: { method: string; body: any }[] = [];
  const config = { ...defaults(), telegramToken: '123:fake', telegramOwnerChatId: '42' };
  const telegram = new Telegram(() => config, () => {}, new Store(directory), async (...args) => { actions.push(args); });
  // Replace the HTTP boundary; this test never contacts Telegram.
  (telegram as any).api = async (method: string, body: any) => { calls.push({ method, body }); return {}; };
  const proposalId = 'b99bb804-8a7e-4cfc-913b-9553fd00d4c1';
  const callback = (user: number, data: string, chat = user) => ({ update_id: 1, callback_query: { id: 'callback', from: { id: user }, message: { chat: { id: chat } }, data } });
  try {
    await (telegram as any).handle(callback(99, `approve:${proposalId}`, 42));
    assert.equal(actions.length, 0);
    await (telegram as any).handle(callback(42, `approve:${proposalId}`, 99));
    assert.equal(actions.length, 0);
    await (telegram as any).handle(callback(42, `time:${proposalId}:14:15`));
    assert.deepEqual(actions, [['time', proposalId, '14:15']]);
    await telegram.send('Proposal', { id: proposalId, mode: 'live' } as Proposal);
    const send = calls.find(call => call.method === 'sendMessage')!;
    assert.equal(send.body.chat_id, '42');
    assert.match(send.body.reply_markup.inline_keyboard[0][0].text, /coworkers/);
    for (const row of send.body.reply_markup.inline_keyboard) for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  } finally { telegram.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Telegram pairing requires the active code and a private chat belonging to the sender', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-pairing-'));
  let owner = '';
  const telegram = new Telegram(defaults, id => { owner = id; }, new Store(directory), async () => {});
  telegram.pairingCode = 'secret-code'; (telegram as any).pairingExpiresAt = Date.now() + 60000;
  (telegram as any).api = async () => ({});
  try {
    await (telegram as any).handle({ message: { chat: { id: 42, type: 'group' }, from: { id: 42 }, text: '/start secret-code' } });
    assert.equal(owner, '');
    await (telegram as any).handle({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/start wrong-code' } });
    assert.equal(owner, '');
    await (telegram as any).handle({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/start secret-code' } });
    assert.equal(owner, '42'); assert.equal(telegram.pairingCode, null);
  } finally { telegram.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Telegram custom-time replies bind to the paired owner, exact prompt, expiry and request', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-time-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { ...defaults(), telegramToken: '123:fake', telegramOwnerChatId: '42' }, actions: unknown[] = [], calls: any[] = [];
  const make = () => new Telegram(() => config, () => {}, new Store(directory), async (...args) => { actions.push(args); });
  const tg = make(); tg.connected = true;
  (tg as any).api = async (method: string, body: unknown) => { calls.push({ method, body }); return { message_id: 321 }; };
  await tg.askTime('request-id', 'Coffee', 'Asia/Hong_Kong', Date.now() + 60000);
  assert.equal(calls[0].body.reply_markup.force_reply, true);
  const restarted = make(); (restarted as any).api = (tg as any).api;
  const reply = (user: number, text: string, quotedId = 321) => ({ message: { message_id: 400, date: Date.now() / 1000, chat: { id: user, type: 'private' }, from: { id: user }, text, reply_to_message: { message_id: quotedId } } });
  await (restarted as any).handle(reply(99, '17:45')); await (restarted as any).handle(reply(42, '17:45', 322)); await (restarted as any).handle(reply(42, '25:00')); assert.equal(actions.length, 0);
  await (restarted as any).handle(reply(42, '17:45')); assert.deepEqual(actions, [['peertime', 'request-id', '17:45']]);
  await (restarted as any).handle(reply(42, '17:45')); assert.equal(actions.length, 1);
  await tg.askTime('expired', 'Coffee', 'Asia/Hong_Kong', Date.now() - 1); await (tg as any).handle(reply(42, '17:45')); assert.equal(actions.length, 1);
  tg.stop(); assert.deepEqual(new Store(directory).read('telegram-time-prompts', {}), {});
});

test('Telegram reconnect after stop uses a fresh abort signal and only one polling loop', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-reconnect-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let active = 0, maxActive = 0, polls = 0;
  const http = (async (input, init) => {
    assert.equal(init?.signal?.aborted, false);
    if (String(input).endsWith('/getUpdates')) {
      active++; polls++; maxActive = Math.max(active, maxActive);
      return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { active--; reject(new Error('aborted')); }, { once: true }); });
    }
    return new Response(JSON.stringify({ ok: true, result: String(input).endsWith('/getMe') ? { username: 'demo' } : { url: '' } }));
  }) as typeof fetch;
  const tg = new Telegram(() => ({ ...defaults(), telegramToken: '123:fake', telegramOwnerChatId: '42' }), () => {}, new Store(directory), async () => {}, http);
  await tg.connect(); tg.stop(); await tg.connect(); assert.equal(tg.connected, true); assert.equal(maxActive, 1); assert.equal(polls, 2); tg.stop();
  await new Promise(resolve => setImmediate(resolve));
});
