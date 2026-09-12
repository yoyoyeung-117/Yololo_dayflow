import express from 'express';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, defaults, initialState } from './store.js';
import { Engine } from './engine.js';
import { LocalModel } from './llm.js';
import { Discord } from './discord.js';
import { Zoom } from './zoom.js';
import { ReplyInbox } from './inbox.js';
import { ReplyTunnel } from './tunnel.js';
import { Telegram } from './telegram.js';
import { recipientLabel } from './transport.js';
import { platformNames, type Coworker, type Settings, type State } from '../shared/types.js';

const baseUrl = z.union([z.literal(''), z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; }, 'Enter the public HTTPS base URL without a path.')]);
const settingsSchema = z.object({
  coworkers: z.array(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(60), platform: z.enum(['discord', 'zoom']), address: z.string().trim().max(254), enabled: z.boolean() })).max(8).refine(people => new Set(people.map(p => p.id)).size === people.length, 'Coworker IDs must be unique.').optional(),
  telegramToken: z.string().trim().max(200).optional(),
  discordToken: z.string().trim().max(250).optional(),
  discordChannelId: z.union([z.literal(''), z.string().regex(/^\d{15,22}$/, 'Copy the channel ID from Discord Developer Mode.')]).optional(),
  zoomClientId: z.string().trim().max(200).optional(), zoomClientSecret: z.string().trim().max(250).optional(), zoomRedirectBaseUrl: baseUrl.optional(),
  ollamaUrl: z.url().refine(value => { const url = new URL(value); return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; }, 'Use a local Ollama URL, e.g. http://127.0.0.1:11434.').optional(),
  ollamaModel: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,100}$/).optional(),
}).strict();

export function createApp(directory = path.resolve('.local')) {
  const store = new Store(directory), base = defaults(), savedSettings = store.read<Partial<Settings>>('settings', {});
  let settings = Object.fromEntries(Object.entries(base).map(([key, fallback]) => [key, savedSettings[key as keyof Settings] ?? fallback])) as Settings;
  const legacyCoworkers = settings.coworkers as { platform: string }[];
  if (legacyCoworkers.some(person => !['discord', 'zoom'].includes(person.platform))) {
    store.write('coworkers-before-owner-only-telegram', settings.coworkers);
    settings.coworkers = settings.coworkers.filter(person => ['discord', 'zoom'].includes(person.platform));
  }
  // Keep owner pairing and local-model configuration; remove obsolete transport fields from active settings.
  store.write('settings', settings);
  const getSettings = () => settings;
  const model = new LocalModel(getSettings), discord = new Discord(getSettings, store), zoom = new Zoom(getSettings, store);
  const webhookPort = Number(process.env.WEBHOOK_PORT || 4319);
  const tunnel = new ReplyTunnel(webhookPort, url => { settings.zoomRedirectBaseUrl = url; store.write('settings', settings); });
  const activeDelivery = () => engine.state.mode === 'live' && ['preparing', 'sending', 'waiting', 'attention', 'uncertain'].includes(engine.state.phase);
  let engine: Engine, inbox: ReplyInbox;
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
  if (savedState.proposal && (savedState.proposal.transport !== 'social' || savedState.proposal.people.some(person => (person.platform as string) === 'telegram'))) { store.write('state-before-social', savedState); savedState = initialState(); }
  const readiness = (person: Coworker) => {
    if (!person.address) return 'Enter the coworker’s Discord ID or Zoom contact email';
    if (person.platform === 'discord') return discord.connected ? '' : 'Connect Discord and choose a channel';
    return zoom.connected ? '' : 'Authorize your Zoom account';
  };
  const ownerReady = () => telegram.connected && Boolean(settings.telegramOwnerChatId);
  const destination = async () => {
    if (!ownerReady()) throw new Error('Connect and pair Telegram for your private approvals first.');
    const people = settings.coworkers.filter(p => p.enabled);
    if (!people.length) throw new Error('Add and enable at least one coworker in Connections.');
    for (const person of people) {
      const reason = readiness(person); if (reason) throw new Error(`${person.name}: ${reason}.`);
      if (person.platform === 'zoom') await zoom.checkContact(person.address);
    }
    const used = new Set(people.map(p => p.platform));
    const fingerprint = createHash('sha256').update(JSON.stringify({
      ...(used.has('discord') ? { discord: settings.discordToken, channel: settings.discordChannelId } : {}),
      ...(used.has('zoom') ? { zoom: settings.zoomClientId, user: zoom.userId } : {}),
    })).digest('hex');
    const platforms = [...used].map(p => platformNames[p]).join(' + ');
    return { destinationId: fingerprint, destinationName: `${platforms}${used.has('discord') ? ` · #${discord.channelName}` : ''}`, people: people.map(({ id, name, platform, address }) => ({ id, name, platform, address })) };
  };
  engine = new Engine({ save: state => store.write('state', state), opening: () => model.opening(), interpret: (text, time) => model.interpret(text, time), destination,
    send: (person, proposal) => {
      if (person.platform === 'discord') return discord.sendProposal(person, proposal);
      if (person.platform === 'zoom') return zoom.sendProposal(person, proposal);
      throw new Error('Coworker messages must use Discord or Zoom Team Chat.');
    },
    notify: (text, proposal) => telegram.send(text, proposal),
  }, savedState);
  inbox = new ReplyInbox(engine, store);
  const app = express(); app.disable('x-powered-by');
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
    const { telegramToken: _token, discordToken: _discord, zoomClientSecret: _zoom, ...publicSettings } = settings;
    const people = settings.coworkers.map(person => ({ ...person, ready: !readiness(person), reason: readiness(person) }));
    const enabled = people.filter(p => p.enabled);
    res.json({ state: engine.state, settings: publicSettings, integrations: {
      ready: ownerReady() && enabled.length > 0 && enabled.every(p => p.ready), coworkers: people,
      telegram: { configured: Boolean(settings.telegramToken), connected: telegram.connected, paired: Boolean(settings.telegramOwnerChatId), username: telegram.username, pairingCode: telegram.pairingCode, error: telegram.error },
      discord: { configured: discord.configured, connected: discord.connected, channelName: discord.channelName, botName: discord.botName, error: discord.error },
      zoom: { configured: zoom.configured, connected: zoom.connected, account: zoom.account, error: zoom.error, redirectUrl: zoom.redirectUrl, tunnel: tunnel.status }, llm: model.status,
    }});
  });
  app.post('/api/settings', (req, res) => {
    if (activeDelivery()) throw new Error('Finish the active conversation before changing connections.');
    const input = settingsSchema.parse(req.body);
    const next = { ...settings, ...input, telegramToken: input.telegramToken || settings.telegramToken, discordToken: input.discordToken || settings.discordToken, zoomClientSecret: input.zoomClientSecret || settings.zoomClientSecret };
    if (next.telegramToken && !/^\d+:[A-Za-z0-9_-]+$/.test(next.telegramToken)) throw new Error('That does not look like a Telegram bot token.');
    const telegramChanged = next.telegramToken !== settings.telegramToken;
    const discordChanged = next.discordToken !== settings.discordToken || next.discordChannelId !== settings.discordChannelId;
    const zoomChanged = next.zoomClientId !== settings.zoomClientId || next.zoomClientSecret !== settings.zoomClientSecret;
    next.coworkers = next.coworkers.map(person => {
      if (person.platform === 'discord' && person.address && !/^\d{15,22}$/.test(person.address)) throw new Error(`${person.name}: enter a Discord user ID, not a username.`);
      if (person.platform === 'zoom' && person.address && !z.email().safeParse(person.address).success) throw new Error(`${person.name}: enter their Zoom Team Chat contact email.`);
      return { ...person, address: person.platform === 'zoom' ? person.address.toLowerCase() : person.address };
    });
    const addresses = next.coworkers.filter(p => p.address).map(p => `${p.platform}:${p.address}`);
    if (new Set(addresses).size !== addresses.length) throw new Error('Each coworker must have a different account within their platform.');
    next.ollamaUrl = next.ollamaUrl.replace(/\/$/, ''); next.zoomRedirectBaseUrl = next.zoomRedirectBaseUrl.replace(/\/$/, '');
    if (telegramChanged) { telegram.stop(); next.telegramOwnerChatId = ''; }
    if (discordChanged) discord.invalidate();
    if (zoomChanged) zoom.invalidate();
    settings = next; store.write('settings', settings);
    if (telegramChanged) { store.write('telegram-offset', 0); telegram = makeTelegram(); }
    res.json({ ok: true });
  });
  app.post('/api/telegram/connect', async (_req, res) => { await telegram.connect(); res.json({ ok: true }); });
  app.post('/api/discord/connect', async (_req, res) => { await discord.check(); res.json({ ok: true }); });
  app.post('/api/zoom/tunnel/start', (_req, res) => { tunnel.start(); res.json({ ok: true }); });
  app.post('/api/zoom/authorize', (_req, res) => {
    if (activeDelivery()) throw new Error('Finish monitoring before changing Zoom authorization.');
    if (settings.zoomRedirectBaseUrl.includes('.trycloudflare.com') && (!tunnel.status.running || tunnel.status.url !== settings.zoomRedirectBaseUrl)) throw new Error('Start the Zoom authorization connection and update its redirect URL in Zoom first.');
    res.json({ url: zoom.authorizeUrl() });
  });
  app.post('/api/zoom/connect', async (_req, res) => { await zoom.check(); for (const p of settings.coworkers.filter(p => p.platform === 'zoom' && p.enabled && p.address)) await zoom.checkContact(p.address); res.json({ ok: true }); });
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
    await telegram.send(`${p.mode === 'live' ? 'LIVE MEETING PROPOSAL' : 'SCENARIO REPLAY'}\n\nRecipients: ${p.people.map(recipientLabel).join(', ')}\nDestination: ${p.destinationName}\n\n${p.text}\n\nApprove this exact proposal?`, p); res.json({ ok: true });
  });
  app.post('/api/replay/reply', async (req, res) => {
    if (engine.state.mode !== 'replay') throw new Error('Simulated replies are disabled for live messages.');
    if (!engine.state.proposal || !['waiting', 'attention', 'agreed'].includes(engine.state.phase)) throw new Error('Approve the replay proposal first.');
    const input = z.object({ personId: z.string(), text: z.string().min(1).max(2000) }).parse(req.body);
    if (!engine.state.proposal.people.some(p => p.id === input.personId)) throw new Error('Unknown coworker.');
    await engine.reply(engine.state.proposal.id, input.personId, input.text, randomUUID()); res.json({ ok: true });
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API route.' }); });
  app.use(express.static(path.resolve('dist')));
  app.get('/', (_req, res) => { res.status(503).send('Run npm run build, or use http://localhost:5173 with npm run dev.'); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    res.status(400).json({ error: error instanceof Error ? error.message : 'The action could not be completed.' });
  });
  // Only this isolated listener is tunneled. It exposes one state-validated OAuth callback.
  const webhookApp = express(); webhookApp.disable('x-powered-by');
  webhookApp.get('/oauth/zoom/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    try {
      if (activeDelivery()) throw new Error('Finish monitoring in Dayflow before changing your Zoom account.');
      await zoom.callback(typeof req.query.code === 'string' ? req.query.code : '', typeof req.query.state === 'string' ? req.query.state : '');
      res.type('html').send('<!doctype html><title>Zoom connected · Dayflow</title><main style="font:18px system-ui;max-width:520px;margin:15vh auto;padding:24px"><h1>Zoom is connected.</h1><p>Return to Dayflow on your Mac. Add a Team Chat contact and verify the connection.</p></main>');
    } catch { res.status(400).type('text').send('Zoom could not be connected. Return to Dayflow, check the redirect URL and scopes, then start authorization again.'); }
  });
  webhookApp.use((_req, res) => { res.sendStatus(404); });
  let polling = false;
  const poll = async () => {
    if (polling) return; polling = true;
    try {
      const p = engine.state.proposal;
      if (p?.mode === 'live' && ['waiting', 'attention', 'agreed', 'uncertain'].includes(engine.state.phase)) {
        const receive = (event: Parameters<ReplyInbox['receive']>[0]) => engine.state.proposal?.id === p.id ? inbox.receive(event) : Promise.resolve();
        const results = await Promise.allSettled([discord.poll(p, receive), zoom.poll(p, receive)]);
        for (const result of results) if (result.status === 'rejected') engine.state.error = 'A platform could not check replies. See Connections for its status.';
      }
    } finally { polling = false; }
  };
  const start = () => {
    void model.check();
    if (discord.configured) void discord.check().catch(() => {});
    if (zoom.configured) void zoom.check().catch(() => {});
    if (settings.telegramToken && settings.telegramOwnerChatId) void telegram.connect().catch(() => {});
    const replyTimer = setInterval(() => void poll(), 6000); replyTimer.unref();
    const inboxTimer = setInterval(() => void inbox.drain().catch(() => { engine.state.error = 'A reply remains queued. Check local storage, then restart Dayflow.'; }), 500); inboxTimer.unref();
    const modelTimer = setInterval(() => void model.check(), 30000); modelTimer.unref();
    return () => { clearInterval(modelTimer); clearInterval(replyTimer); clearInterval(inboxTimer); telegram.stop(); tunnel.stop(); };
  };
  return { app, webhookApp, webhookPort, engine, model, telegram, discord, zoom, inbox, poll, tunnel, start };
}
