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
    assert.match(send.body.reply_markup.inline_keyboard[0][0].text, /WhatsApp/);
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
