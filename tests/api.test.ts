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

test('disconnect pauses requests and Calendar coordination, preserves configuration and persists across restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-disconnect-'));
  const a = createApp(directory), server = a.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (route: string, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await post('/api/settings', { telegramToken: '123:fake', discordToken: 'fake', discordChannelId: '888888888888888888' });
    for (const platform of ['telegram', 'discord', 'zoom', 'calendar']) { const r = await post(`/api/${platform}/disconnect`); assert.equal(r.status, 200, await r.text()); }
    assert.equal(a.peers.state.enabled, false); assert.equal(a.calendar.state.paused, true); assert.equal(a.calendar.state.connected, false);
    assert.equal((await post('/api/calendar/refresh')).status, 400);
    const b = createApp(directory); assert.equal(b.peers.state.enabled, false); assert.equal(b.calendar.state.paused, true);
    let connects = 0; b.discord.check = async () => { connects++; }; b.zoom.check = async () => { connects++; }; b.telegram.connect = async () => { connects++; }; b.model.check = async () => b.model.status;
    const stop = b.start(); await new Promise(resolve => setImmediate(resolve)); stop(); assert.equal(connects, 0);
    const state = await fetch(`${base}/api/state`).then(r => r.json()) as any;
    assert.equal(state.integrations.discord.configured, true); assert.equal(state.integrations.telegram.configured, true); assert.equal(state.integrations.discord.paused, true);
    a.engine.state.phase = 'sending'; assert.equal((await post('/api/discord/disconnect')).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the former fake scenario endpoints cannot create or send seeded proposals', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-real-plan-')); const a = createApp(directory);
  const server = a.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const endpoint of ['/api/replay/advance', '/api/proposal/prepare', '/api/replay/reset', '/api/replay/reply']) {
      const r = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ time: '14:00' }) }); assert.equal(r.status, 410);
    }
    assert.equal(a.engine.state.proposal, null);
    const invalid = await fetch(base + '/api/calendar/reschedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: 'fake', day: '2026-09-12', time: '25:00', bufferMinutes: 10 }) }); assert.equal(invalid.status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(directory, { recursive: true, force: true }); }
});
