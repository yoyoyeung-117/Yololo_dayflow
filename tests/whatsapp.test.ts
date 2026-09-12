import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import twilio from 'twilio';
import { createApp } from '../server/app.js';
import { defaults, Store } from '../server/store.js';
import { correlatedWhatsAppReply, WhatsApp, SendFailure, type WebhookFields } from '../server/whatsapp.js';
import type { Proposal } from '../shared/types.js';

const account = `AC${'a'.repeat(32)}`, token = 'b'.repeat(32), from = '+14155238886', alex = '+85212345678', sam = '+85287654321';
const sid = (n: number) => `SM${n.toString(16).padStart(32, '0')}`;
const config = () => ({ ...defaults(), twilioAccountSid: account, twilioAuthToken: token, whatsappFrom: from, whatsappWebhookBaseUrl: 'https://dayflow.example', whatsappRecipients: [{ name: 'Alex', phone: alex }, { name: 'Sam', phone: sam }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function eventually(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.ok(check(), 'Condition did not become true.'); }

test('WhatsApp accepts only current references or the actual recipient’s quoted proposal', () => {
  const p = { id: 'proposal', approvedAt: Date.now(), code: '#DF-ABC123', people: [{ id: alex, name: 'Alex', messageId: sid(1), delivery: 'queued' }] } as Proposal;
  const fields = { From: `whatsapp:${alex}`, MessageSid: sid(2), Body: 'yes' };
  assert.equal(correlatedWhatsAppReply(fields, p), null);
  assert.equal(correlatedWhatsAppReply({ ...fields, Body: '#df-abc123 yes' }, p)?.text, 'yes');
  assert.equal(correlatedWhatsAppReply({ ...fields, OriginalRepliedMessageSid: sid(1) }, p)?.text, 'yes');
  assert.equal(correlatedWhatsAppReply({ ...fields, From: `whatsapp:${sam}`, Body: '#DF-ABC123 yes' }, p), null);
  assert.equal(correlatedWhatsAppReply({ ...fields, OriginalRepliedMessageSid: sid(1), Body: '#DF-FFFFFF yes' }, p), null);
});

test('signed webhooks establish readiness, acknowledge quickly, deduplicate and feed actual proposal replies', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-whatsapp-'));
  new Store(directory).write('settings', config());
  const system = createApp(directory);
  const server = system.webhookApp.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const outgoing: URLSearchParams[] = [];
  (system.whatsapp as any).pause = async () => {};
  (system.whatsapp as any).http = async (_url: string, init: RequestInit) => {
    if (!init.method) return Response.json({ sid: account, status: 'active' });
    outgoing.push(new URLSearchParams(String(init.body)));
    return Response.json({ sid: sid(100 + outgoing.length), status: 'queued' });
  };
  system.model.opening = async () => ({ text: 'I’m running a little behind.', ai: true });
  let release!: () => void, inferenceStarted = false;
  system.model.interpret = async () => { inferenceStarted = true; await new Promise<void>(resolve => { release = resolve; }); return { status: 'accepted', proposedTime: null, ai: true }; };
  const post = async (kind: 'incoming' | 'status', fields: WebhookFields, signature?: string) => {
    const route = `/webhooks/whatsapp/${kind}`;
    return fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature ?? twilio.getExpectedTwilioSignature(token, `https://dayflow.example${route}`, fields) }, body: new URLSearchParams(fields).toString() });
  };
  const hello = (phone: string, n: number) => ({ AccountSid: account, From: `whatsapp:${phone}`, To: `whatsapp:${from}`, MessageSid: sid(n), Body: 'hello' });
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await post('incoming', hello(alex, 1), 'forged')).status, 403);
    assert.equal(system.whatsapp.recipients()[0].windowOpen, false);
    assert.equal((await post('incoming', { ...hello(alex, 2), AccountSid: `AC${'c'.repeat(32)}` })).status, 403);
    assert.equal((await post('incoming', { ...hello(alex, 3), To: 'whatsapp:+15551234567' })).status, 403);
    await system.whatsapp.check();
    await assert.rejects(system.whatsapp.destination(), /send hello/);
    assert.equal((await post('incoming', hello(alex, 4))).status, 200);
    assert.equal((await post('incoming', hello(sam, 5))).status, 200);
    assert.equal(system.whatsapp.ready, true);
    const firstSeen = system.whatsapp.recipients()[0].lastInboundAt;
    await tick(); await post('incoming', hello(alex, 4));
    assert.equal(system.whatsapp.recipients()[0].lastInboundAt, firstSeen, 'Duplicate webhook must not extend the messaging window.');
    await system.drainWebhooks();
    system.engine.reset('live'); await system.engine.advance();
    assert.equal(outgoing.length, 0);
    const proposal = system.engine.state.proposal!;
    await system.engine.approve(proposal.id);
    assert.equal(outgoing.length, 2);
    assert.equal(outgoing[0].get('To'), `whatsapp:${alex}`);
    assert.equal(outgoing[1].get('To'), `whatsapp:${sam}`);
    assert.equal(outgoing[0].get('From'), `whatsapp:${from}`);
    assert.equal(outgoing[0].get('StatusCallback'), 'https://dayflow.example/webhooks/whatsapp/status');
    assert.equal(system.engine.state.proposal!.people[0].delivery, 'queued');
    const accepted = { ...hello(alex, 6), Body: `${proposal.code} yes` };
    // If the webhook waited for inference this would hang, because release() has not been called.
    const response = await Promise.race([post('incoming', accepted), new Promise<never>((_, reject) => { const timeout = setTimeout(() => reject(new Error('Webhook did not acknowledge before inference')), 1000); timeout.unref(); })]);
    assert.equal(response.status, 200); assert.match(await response.text(), /<Response\/>/);
    await eventually(() => inferenceStarted);
    assert.equal(system.engine.state.proposal!.people[0].status, 'pending');
    release(); await eventually(() => system.engine.state.proposal!.people[0].status === 'accepted');
    await post('incoming', accepted); await system.drainWebhooks();
    assert.equal(system.engine.state.processedMessages.filter(id => id === accepted.MessageSid).length, 1);
    await post('status', { AccountSid: account, MessageSid: sid(102), MessageStatus: 'read' });
    await eventually(() => system.engine.state.proposal!.people[1].delivery === 'read');
    assert.equal(system.engine.state.proposal!.people[1].status, 'pending');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('WhatsApp adapter spaces sandbox sends and distinguishes rejected from uncertain sends', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-send-'));
  const pauses: number[] = [];
  let count = 0;
  const wa = new WhatsApp(config, new Store(directory), (async () => { count++; if (count === 3) return Response.json({ code: 63015 }, { status: 400 }); if (count === 4) throw new Error('network timeout'); return Response.json({ sid: sid(count) }); }) as typeof fetch, async ms => { pauses.push(ms); });
  try {
    await wa.send(alex, 'message'); await wa.send(sam, 'message');
    assert.ok(pauses[0] > 2900 && pauses[0] <= 3100);
    await assert.rejects(wa.send(alex, 'message'), error => error instanceof SendFailure && error.definitive && /join/.test(error.message));
    await assert.rejects(wa.send(alex, 'message'), error => error instanceof SendFailure && !error.definitive);
    assert.equal(count, 4, 'No automatic HTTP retry should occur.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('old transport state is archived and Telegram pairing survives the migration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-migrate-'));
  const store = new Store(directory);
  store.write('settings', { ...defaults(), telegramToken: '123:fake', telegramOwnerChatId: '42', microsoftClientId: 'legacy' });
  store.write('state', { phase: 'approval', proposal: { id: 'old-proposal' } });
  try {
    const system = createApp(directory);
    assert.equal(system.engine.state.phase, 'observing');
    assert.equal(store.read<any>('state-before-whatsapp', {}).proposal.id, 'old-proposal');
    assert.equal(store.read<any>('settings', {}).telegramOwnerChatId, '42');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
