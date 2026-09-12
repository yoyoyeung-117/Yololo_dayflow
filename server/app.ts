import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, defaults, initialState } from './store.js';
import { Engine } from './engine.js';
import { LocalModel } from './llm.js';
import { WhatsApp, PHONE_PATTERN } from './whatsapp.js';
import { ReplyTunnel } from './tunnel.js';
import { createWebhookApp } from './webhooks.js';
import { Telegram } from './telegram.js';
import type { Settings, State } from '../shared/types.js';

const settingsSchema = z.object({
  twilioAccountSid: z.union([z.literal(''), z.string().regex(/^AC[0-9a-f]{32}$/i)]),
  twilioAuthToken: z.string().max(200).optional(),
  whatsappFrom: z.string().regex(PHONE_PATTERN, 'Use an international phone number, e.g. +14155238886.'),
  whatsappSandboxCode: z.string().max(80).regex(/^[a-zA-Z0-9 -]*$/),
  whatsappWebhookBaseUrl: z.union([z.literal(''), z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; }, 'Enter only the public HTTPS base URL, without a path.')]),
  whatsappRecipients: z.array(z.object({ name: z.string().trim().min(1).max(60), phone: z.string().regex(PHONE_PATTERN, 'Use + followed by country code and phone number.') })).max(5).refine(people => new Set(people.map(p => p.phone)).size === people.length, 'Each coworker must have a different phone number.'),
  telegramToken: z.string().max(200).optional(),
  ollamaUrl: z.url().refine(value => { const url = new URL(value); return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; }, 'Use a local Ollama URL, e.g. http://127.0.0.1:11434.'),
  ollamaModel: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,100}$/),
});

export function createApp(directory = path.resolve('.local')) {
  const store = new Store(directory);
  const base = defaults(), savedSettings = store.read<Partial<Settings>>('settings', {});
  // Migrate only supported fields. Telegram pairing and Ollama settings survive the transport change.
  let settings = Object.fromEntries(Object.entries(base).map(([key, fallback]) => [key, savedSettings[key as keyof Settings] ?? fallback])) as Settings;
  const getSettings = () => settings;
  const model = new LocalModel(getSettings), whatsapp = new WhatsApp(getSettings, store);
  const webhookPort = Number(process.env.WEBHOOK_PORT || 4319);
  const tunnel = new ReplyTunnel(webhookPort, url => { settings.whatsappWebhookBaseUrl = url; store.write('settings', settings); });
  const replyConnectionReady = () => !settings.whatsappWebhookBaseUrl.includes('.trycloudflare.com') || (tunnel.status.running && tunnel.status.url === settings.whatsappWebhookBaseUrl);
  let engine: Engine;
  const makeTelegram = () => new Telegram(getSettings, id => { settings.telegramOwnerChatId = id; store.write('settings', settings); }, store, async (action, id, value) => {
    if (action === 'approve') await engine.approve(id);
    else if (action === 'dismiss') engine.dismiss(id);
    else if (action === 'time') {
      if (engine.state.proposal?.id !== id || engine.state.phase !== 'approval') throw new Error('Open the latest proposal to change its time.');
      await engine.prepare(value || '');
    } else throw new Error('Unknown action.');
  });
  let telegram = makeTelegram();
  let savedState = store.read<State>('state', initialState());
  if (savedState.proposal && savedState.proposal.transport !== 'whatsapp') {
    store.write('state-before-whatsapp', savedState); savedState = initialState();
  }
  engine = new Engine({
    save: state => store.write('state', state),
    opening: () => model.opening(), interpret: (text, time) => model.interpret(text, time),
    destination: () => { if (!replyConnectionReady()) throw new Error('Restart the reply connection in Connections and save its new incoming URL in Twilio.'); return whatsapp.destination(); }, send: (phone, text) => whatsapp.send(phone, text),
    notify: (text, proposal) => telegram.send(text, proposal),
  }, savedState);
  const webhooks = createWebhookApp(whatsapp, engine, store);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return res.status(403).json({ error: 'Dayflow is a local-only demo. Open it on localhost.' });
    if (req.headers.origin) {
      try { const origin = new URL(req.headers.origin); if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || ![String(process.env.PORT || 4317), '5173'].includes(origin.port)) return res.status(403).json({ error: 'Untrusted browser origin.' }); }
      catch { return res.status(403).json({ error: 'Invalid browser origin.' }); }
    }
    if (req.path.startsWith('/api') && req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Send application/json.' });
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/state', (_req, res) => {
    const { telegramToken: _token, twilioAuthToken: _auth, ...publicSettings } = settings;
    res.json({ state: engine.state, settings: publicSettings, integrations: {
      whatsapp: { configured: whatsapp.configured, connected: whatsapp.connected, ready: whatsapp.ready && replyConnectionReady(), error: whatsapp.error, ...whatsapp.urls(), recipients: whatsapp.recipients(), tunnel: tunnel.status },
      telegram: { configured: Boolean(settings.telegramToken), paired: Boolean(settings.telegramOwnerChatId), username: telegram.username, pairingCode: telegram.pairingCode, error: telegram.error },
      llm: model.status,
    }});
  });
  const activeDelivery = () => engine.state.mode === 'live' && ['preparing', 'sending', 'waiting', 'attention', 'uncertain'].includes(engine.state.phase);
  app.post('/api/settings', (req, res) => {
    if (activeDelivery()) throw new Error('Finish the active WhatsApp conversation before changing connections.');
    const input = settingsSchema.parse(req.body);
    const token = input.telegramToken?.trim() || settings.telegramToken;
    const authToken = input.twilioAuthToken?.trim() || settings.twilioAuthToken;
    if (token && !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('That does not look like a Telegram bot token.');
    if (authToken && !/^[a-f0-9]{32}$/i.test(authToken)) throw new Error('Twilio Auth Token should be the 32-character token shown in your console.');
    if (input.whatsappRecipients.some(p => p.phone === input.whatsappFrom)) throw new Error('The sender number cannot also be a coworker.');
    const credentialsChanged = input.twilioAccountSid !== settings.twilioAccountSid || authToken !== settings.twilioAuthToken || input.whatsappFrom !== settings.whatsappFrom;
    const telegramChanged = token !== settings.telegramToken;
    if (credentialsChanged) whatsapp.invalidate();
    if (telegramChanged) telegram.stop();
    settings = { ...settings, ...input, ollamaUrl: input.ollamaUrl.replace(/\/$/, ''), whatsappWebhookBaseUrl: input.whatsappWebhookBaseUrl.replace(/\/$/, ''), twilioAuthToken: authToken, telegramToken: token, ...(telegramChanged ? { telegramOwnerChatId: '' } : {}) };
    store.write('settings', settings);
    if (telegramChanged) { store.write('telegram-offset', 0); telegram = makeTelegram(); }
    res.json({ ok: true });
  });
  app.post('/api/whatsapp/connect', async (_req, res) => { await whatsapp.check(); res.json({ ok: true }); });
  app.post('/api/whatsapp/tunnel/start', (_req, res) => {
    if (engine.state.phase === 'sending') throw new Error('Wait for sending to finish before restarting the reply connection.');
    tunnel.start(); res.json({ ok: true });
  });
  app.post('/api/telegram/connect', async (_req, res) => { await telegram.connect(); res.json({ ok: true }); });
  app.post('/api/llm/check', async (_req, res) => { res.json(await model.check()); });
  app.post('/api/replay/reset', (req, res) => { engine.reset(z.enum(['replay', 'live']).parse(req.body.mode)); res.json({ ok: true }); });
  app.post('/api/replay/advance', async (_req, res) => { await engine.advance(); res.json({ ok: true }); });
  app.post('/api/proposal/prepare', async (req, res) => { await engine.prepare(z.string().parse(req.body.time)); res.json({ ok: true }); });
  app.post('/api/proposal/approve', async (req, res) => { await engine.approve(z.uuid().parse(req.body.id)); res.json({ ok: true }); });
  app.post('/api/proposal/dismiss', (req, res) => { engine.dismiss(z.uuid().parse(req.body.id)); res.json({ ok: true }); });
  app.post('/api/proposal/finish', (_req, res) => { engine.finishMonitoring(); res.json({ ok: true }); });
  app.post('/api/proposal/notify', async (_req, res) => {
    const p = engine.state.proposal;
    if (!p || engine.state.phase !== 'approval' || p.expiresAt < Date.now()) throw new Error('Prepare a current proposal first.');
    if (!settings.telegramOwnerChatId) throw new Error('Pair your Telegram account in Connections first.');
    await telegram.send(`${p.mode === 'live' ? 'LIVE WHATSAPP PROPOSAL' : 'SCENARIO REPLAY'}\n\nSend individual messages to: ${p.people.map(person => `${person.name}${p.mode === 'live' ? ' (' + person.id + ')' : ''}`).join(', ')}\n\n${p.text}\n\nApprove this exact proposal?`, p);
    res.json({ ok: true });
  });
  app.post('/api/replay/reply', async (req, res) => {
    if (engine.state.mode !== 'replay') throw new Error('Simulated replies are disabled for live WhatsApp.');
    if (!engine.state.proposal || !['waiting', 'attention', 'agreed'].includes(engine.state.phase)) throw new Error('Approve the replay proposal first.');
    const input = z.object({ personId: z.string(), text: z.string().min(1).max(2000) }).parse(req.body);
    if (!engine.state.proposal.people.some(p => p.id === input.personId)) throw new Error('Unknown coworker.');
    await engine.reply(engine.state.proposal.id, input.personId, input.text, randomUUID()); res.json({ ok: true });
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API route.' }); });
  app.use(express.static(path.resolve('dist')));
  app.get('/', (_req, res) => { res.status(503).send('Frontend not built yet. Run npm run build, or use http://localhost:5173 with npm run dev.'); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    res.status(400).json({ error: error instanceof Error ? error.message : 'The action could not be completed.' });
  });
  const start = () => {
    void model.check();
    if (whatsapp.configured) void whatsapp.check().catch(() => {});
    if (settings.telegramToken && settings.telegramOwnerChatId) void telegram.connect().catch(error => { telegram.error = (error as Error).message; });
    const stopWebhooks = webhooks.start();
    const modelTimer = setInterval(() => void model.check(), 30000); modelTimer.unref();
    return () => { clearInterval(modelTimer); stopWebhooks(); telegram.stop(); tunnel.stop(); };
  };
  return { app, webhookApp: webhooks.app, drainWebhooks: webhooks.drain, webhookPort, engine, model, whatsapp, tunnel, start };
}
