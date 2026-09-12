import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

test('API protects local actions and does not return the bot token', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-test-'));
  const { app } = createApp(directory);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const hostile = await fetch(`${base}/api/proposal/approve`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(hostile.status, 403);
    const formPost = await fetch(`${base}/api/proposal/approve`, { method: 'POST', body: 'id=x' });
    assert.equal(formPost.status, 415);
    const snapshot = await fetch(`${base}/api/state`).then(r => r.json()) as any;
    assert.equal('telegramToken' in snapshot.settings, false);
    const noProposal = await fetch(`${base}/api/proposal/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'ee1766de-2bc9-4f6a-9832-498e987ca803' }) });
    assert.equal(noProposal.status, 400);
    const calendarState = await fetch(`${base}/api/calendar/state`).then(r => r.json()) as any;
    assert.equal(calendarState.connected, false); assert.equal(calendarState.plan, null);
    const invalidApproval = await fetch(`${base}/api/calendar/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'ee1766de-2bc9-4f6a-9832-498e987ca803' }) });
    assert.equal(invalidApproval.status, 400);
    const hostileCalendar = await fetch(`${base}/api/calendar/connect`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(hostileCalendar.status, 403);

  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
