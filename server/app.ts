import express from 'express';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Store, defaults, initialState } from './store.js';
import { Engine } from './engine.js';
import { LocalModel } from './llm.js';
import { Discord } from './discord.js';
import { Zoom } from './zoom.js';
import { ReplyInbox } from './inbox.js';
import { ReplyTunnel } from './tunnel.js';
import { Telegram } from './telegram.js';
import { TravelAgent } from './travel.js';
import { TeammateRequests } from './requests.js';
import { CalendarAgent } from './calendar.js';
import { AppleCalendar } from './calendar-bridge.js';
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
  const paused = store.read<Record<string, boolean>>('disconnected-integrations', {});
  const setPaused = (platform: string, value: boolean) => { paused[platform] = value; store.write('disconnected-integrations', paused); };
  const connecting = new Set<string>();
  const connect = async (platform: string, action: () => Promise<unknown>) => {
    if (connecting.has(platform)) throw new Error('A connection check is already running for this platform.');
    connecting.add(platform);
    try { await action(); setPaused(platform, false); } finally { connecting.delete(platform); }
  };
  const activeDelivery = () => travel?.working || peers?.working || calendar?.active || engine.state.mode === 'live' && ['preparing', 'sending', 'waiting', 'attention', 'uncertain'].includes(engine.state.phase);
  let engine: Engine, inbox: ReplyInbox;
  let calendar: CalendarAgent;
  let peers: TeammateRequests;
  let travel: TravelAgent;
  const makeTelegram = (): Telegram => new Telegram(getSettings, id => { settings.telegramOwnerChatId = id; store.write('settings', settings); }, store, async (action, id, value) => {
    if (action.startsWith('peer')) {
      if (action === 'peerother') { const r = peers.awaiting(id); return telegram.askTime(id, r.event!.title, r.timezone!, r.expiresAt); }
      if (!['peerapprove', 'peerreject', 'peertime'].includes(action)) throw new Error('Unknown teammate action.');
      return peers.action(id, action === 'peerreject' ? 'reject' : 'accept', action === 'peertime' ? value : undefined);
    }
    if (peers.working) throw new Error('A teammate request is being processed. Try again shortly.');
    if (action === 'tripplan') return travel.action(id);
    if (action.startsWith('day')) return calendar.action(action, id, value);
    if (calendar.active) throw new Error('Finish the active calendar plan in My calendar first.');
    if (action === 'approve') throw new Error('The practice scenario has been replaced. Open Plan my day to review a real Calendar event.');
    else if (action === 'dismiss') engine.dismiss(id);
    else if (action === 'time') {
      throw new Error('Open Plan my day to select a real Calendar event and time.');
    } else throw new Error('Unknown action.');
  });
  let telegram: Telegram = makeTelegram();
  let savedState = store.read<State>('state', initialState());
  if (savedState.proposal && (savedState.proposal.transport !== 'social' || savedState.proposal.people.some(person => (person.platform as string) === 'telegram'))) { store.write('state-before-social', savedState); savedState = initialState(); }
  const readiness = (person: Coworker) => {
    if (!person.address) return 'Enter the coworker’s Discord ID or Zoom contact email';
    if (person.platform === 'discord') return discord.connected ? '' : 'Connect Discord and choose a channel';
    return zoom.connected ? '' : 'Authorize your Zoom account';
  };
  const ownerReady = () => telegram.connected && Boolean(settings.telegramOwnerChatId);
  const destination = async (personIds?: string[]) => {
    if (!ownerReady()) throw new Error('Connect and pair Telegram for your private approvals first.');
    const people = settings.coworkers.filter(p => p.enabled && (!personIds || personIds.includes(p.id)));
    if (personIds && people.length !== new Set(personIds).size) throw new Error('A selected friend is missing or disabled. Update the event’s people first.');
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
  calendar = new CalendarAgent(store, new AppleCalendar(directory), {
    opening: () => model.opening(), interpret: (text, time) => model.interpret(text, time), destination,
    send: (person, proposal) => person.platform === 'discord' ? discord.sendProposal(person, proposal) : zoom.sendProposal(person, proposal),
    notify: text => telegram.sendButtons(text),
  }, (text, buttons) => telegram.sendButtons(text, buttons), () => engine.state.mode === 'live' && ['approval', 'preparing', 'sending', 'waiting', 'attention', 'uncertain'].includes(engine.state.phase));
  peers = new TeammateRequests(store, calendar, () => settings.coworkers, () => !ownerReady() || !calendar.state.connected || calendar.working || engine.state.mode === 'live' && ['approval', 'preparing', 'sending', 'waiting', 'attention', 'uncertain'].includes(engine.state.phase), (text, buttons) => telegram.sendButtons(text, buttons), (person, text) => person.platform === 'discord' ? discord.sendText(person, text) : zoom.sendText(person, text), Date.now, () => createHash('sha256').update(JSON.stringify([settings.telegramToken, settings.telegramOwnerChatId, settings.discordToken, settings.discordChannelId, settings.zoomClientId, zoom.userId])).digest('hex'));
  travel = new TravelAgent(store, calendar, input => new AppleCalendar(directory).route(input), (text, buttons) => telegram.sendButtons(text, buttons), ownerReady);
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return res.status(403).json({ error: 'DayMade is a local-only demo. Open it on localhost.' });
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
      telegram: { paused: !!paused.telegram, configured: Boolean(settings.telegramToken), connected: telegram.connected, paired: Boolean(settings.telegramOwnerChatId), username: telegram.username, pairingCode: telegram.pairingCode, error: telegram.error },
      discord: { paused: !!paused.discord, configured: discord.configured, connected: discord.connected, channelName: discord.channelName, botName: discord.botName, error: discord.error },
      zoom: { paused: !!paused.zoom, configured: zoom.configured, connected: zoom.connected, account: zoom.account, error: zoom.error, redirectUrl: zoom.redirectUrl, tunnel: tunnel.status }, llm: model.status,
    }});
  });
  app.post('/api/settings', (req, res) => {
    if (activeDelivery() || connecting.size) throw new Error('Finish the active conversation or connection check before changing connections.');
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
  app.post('/api/telegram/connect', async (_req, res) => { await connect('telegram', () => telegram.connect()); res.json({ ok: true }); });
  app.post('/api/discord/connect', async (_req, res) => { await connect('discord', () => discord.check()); res.json({ ok: true }); });
  app.post('/api/zoom/tunnel/start', (_req, res) => { tunnel.start(); res.json({ ok: true }); });
  app.post('/api/zoom/authorize', (_req, res) => {
    if (activeDelivery()) throw new Error('Finish monitoring before changing Zoom authorization.');
    if (settings.zoomRedirectBaseUrl.includes('.trycloudflare.com') && (!tunnel.status.running || tunnel.status.url !== settings.zoomRedirectBaseUrl)) throw new Error('Start the Zoom authorization connection and update its redirect URL in Zoom first.');
    res.json({ url: zoom.authorizeUrl() });
  });
  app.post('/api/zoom/connect', async (_req, res) => { await connect('zoom', async () => { await zoom.check(); for (const p of settings.coworkers.filter(p => p.platform === 'zoom' && p.enabled && p.address)) await zoom.checkContact(p.address); }); res.json({ ok: true }); });
  app.post('/api/llm/check', async (_req, res) => { res.json(await model.check()); });
  app.get('/api/requests/state', (_req, res) => res.json(peers.state));
  app.post('/api/requests/monitor', (req, res) => { peers.configure(z.boolean().parse(req.body.enabled)); res.json(peers.state); });
  app.post('/api/requests/respond', async (req, res) => {
    const input = z.object({ id: z.uuid(), choice: z.enum(['accept', 'reject']), time: z.string().optional() }).strict().parse(req.body);
    await peers.action(input.id, input.choice, input.time); res.json(peers.state);
  });
  app.post('/api/:platform/disconnect', (req, res, next) => {
    if (!['telegram', 'discord', 'zoom', 'calendar'].includes(req.params.platform)) return next();
    if (travel.working || connecting.size || peers.working || calendar.working || engine.working) throw new Error('A send, calendar operation or connection check is in progress. Try disconnecting again when it finishes.');
    peers.configure(false);
    const plan = calendar.state.plan;
    if (plan && !['applied', 'dismissed', 'unresolved'].includes(plan.status)) calendar.dismiss(plan.id);
    if (engine.state.phase === 'approval') engine.dismiss(engine.state.proposal!.id);
    else if (['waiting', 'attention', 'uncertain', 'agreed'].includes(engine.state.phase)) engine.finishMonitoring();
    calendar.configure(false);
    if (req.params.platform === 'telegram') telegram.stop();
    if (req.params.platform === 'discord') discord.invalidate();
    if (req.params.platform === 'zoom') { zoom.disconnect(); tunnel.stop(); }
    if (req.params.platform === 'calendar') calendar.disconnect();
    if (['calendar', 'telegram'].includes(req.params.platform)) travel.disconnect();
    setPaused(req.params.platform, true);
    res.json({ ok: true });
  });
  app.get('/api/travel/state', (_req, res) => { res.json(travel.state); });
  app.post('/api/travel/settings', (req, res) => {
    const input = z.object({ enabled: z.boolean().optional(), mode: z.enum(['walking', 'driving']).optional(), bufferMinutes: z.number().int().min(0).max(60).optional(), origin: z.object({ label: z.string().trim().min(1).max(300), address: z.string().trim().min(3).max(300).optional(), coordinates: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict().optional(), source: z.enum(['browser', 'address']), accuracy: z.number().nonnegative().max(100000).optional() }).strict().refine(o => o.source === 'browser' ? !!o.coordinates && !o.address : !!o.address && !o.coordinates, 'Provide a current location or starting address.').nullable().optional() }).strict().parse(req.body);
    if (input.enabled && (!ownerReady() || !calendar.state.connected)) throw new Error('Connect Apple Calendar and pair Telegram before enabling reminders.');
    const { origin, ...preferences } = input;
    travel.configure({ ...preferences, ...(origin ? { origin: { ...origin, updatedAt: Date.now() } } : origin === null ? { origin: null } : {}) }); res.json(travel.state);
  });
  app.post('/api/travel/check', async (_req, res) => { await travel.check(true); res.json(travel.state); });
  app.post('/api/travel/disconnect', (_req, res) => { travel.disconnect(); res.json(travel.state); });
  app.post('/api/travel/propose', async (req, res) => { if (peers.working) throw new Error('Wait for the teammate request to finish.'); await travel.propose(z.string().min(1).max(1000).parse(req.body.eventId)); res.json(calendar.state); });
  app.use('/api/calendar', (req, _res, next) => { if (req.method === 'POST' && (peers.working || travel.working)) throw new Error('A teammate request is being processed. Try again shortly.'); next(); });
  app.get('/api/calendar/state', async (_req, res) => {
    if (calendar.state.connected && !calendar.state.paused && !calendar.working && !peers.working && (!calendar.state.refreshedAt || Date.now() - calendar.state.refreshedAt >= 60000 || Date.now() >= (calendar.state.day?.dayEnd || 0))) await calendar.refresh().catch(() => {});
    res.json(calendar.state);
  });
  app.post('/api/calendar/connect', async (_req, res) => { await connect('calendar', () => calendar.refresh(true)); res.json(calendar.state); });
  app.post('/api/calendar/refresh', async (_req, res) => { await calendar.refresh(); res.json(calendar.state); });
  app.post('/api/calendar/monitor', (req, res) => { calendar.configure(z.boolean().parse(req.body.enabled)); res.json({ ok: true }); });
  app.post('/api/calendar/rule', (req, res) => {
    const input = z.object({ eventId: z.string().min(1).max(1000), flexible: z.boolean(), personIds: z.array(z.uuid()).max(8) }).strict().parse(req.body);
    if (new Set(input.personIds).size !== input.personIds.length || input.personIds.some(id => !settings.coworkers.some(p => p.id === id && p.enabled))) throw new Error('Select enabled friends from Connections.');
    calendar.rule(input.eventId, { flexible: input.flexible, personIds: input.personIds }); res.json({ ok: true });
  });
  app.post('/api/calendar/reschedule', async (req, res) => {
    const input = z.object({ eventId: z.string().min(1).max(1000), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bufferMinutes: z.number().int().min(0).max(60) }).strict().parse(req.body);
    await calendar.reschedule(input.eventId, input.time, input.day, input.bufferMinutes); res.json(calendar.state);
  });
  app.post('/api/calendar/preview', async (req, res) => { const input = z.object({ eventId: z.string().min(1).max(1000), extraMinutes: z.number().int().min(5).max(120), bufferMinutes: z.number().int().min(0).max(60) }).strict().parse(req.body); await calendar.preview(input.eventId, input.extraMinutes, input.bufferMinutes); res.json(calendar.state); });
  app.post('/api/calendar/approve', async (req, res) => { await calendar.approve(z.uuid().parse(req.body.id)); res.json(calendar.state); });
  app.post('/api/calendar/dismiss', (req, res) => { calendar.dismiss(z.uuid().parse(req.body.id)); res.json(calendar.state); });
  app.post('/api/calendar/notify', async (_req, res) => { await calendar.notifyPlan(); res.json({ ok: true }); });
  app.use(['/api/replay', '/api/proposal'], (_req, _res, next) => { if (calendar.active || peers.working) throw new Error('Finish or stop the active calendar plan in My calendar first.'); next(); });
  app.post('/api/replay/reset', (_req, res) => { res.status(410).json({ error: 'Simulations have been removed. Use your real Calendar.' }); });
  app.post('/api/replay/advance', (_req, res) => { res.status(410).json({ error: 'The fixed practice scenario has been retired. Use Plan my day with Apple Calendar.' }); });
  app.post('/api/proposal/prepare', (_req, res) => { res.status(410).json({ error: 'Choose an event in Plan my day to prepare a Calendar-based proposal.' }); });
  app.post('/api/proposal/approve', (_req, res) => { res.status(400).json({ error: 'Prepare and approve a real Calendar plan in Plan my day.' }); });
  app.post('/api/proposal/dismiss', (req, res) => { engine.dismiss(z.uuid().parse(req.body.id)); res.json({ ok: true }); });
  app.post('/api/proposal/finish', (_req, res) => { engine.finishMonitoring(); res.json({ ok: true }); });
  app.post('/api/proposal/notify', (_req, res) => { res.status(410).json({ error: 'Prepare a real Calendar plan in Plan my day to send an approval card.' }); });
  app.post('/api/replay/reply', (_req, res) => { res.status(410).json({ error: 'Simulated messages have been removed. Replies come from your connected friends.' }); });
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
      if (activeDelivery()) throw new Error('Finish monitoring in DayMade before changing your Zoom account.');
      await connect('zoom', () => zoom.callback(typeof req.query.code === 'string' ? req.query.code : '', typeof req.query.state === 'string' ? req.query.state : ''));
      res.type('html').send('<!doctype html><title>Zoom connected · DayMade</title><main style="font:18px system-ui;max-width:520px;margin:15vh auto;padding:24px"><h1>Zoom is connected.</h1><p>Return to DayMade on your Mac. Add a Team Chat contact and verify the connection.</p></main>');
    } catch { res.status(400).type('text').send('Zoom could not be connected. Return to DayMade, check the redirect URL and scopes, then start authorization again.'); }
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
      if (calendar.state.plan && ['coordinating', 'attention'].includes(calendar.state.plan.status)) {
        for (const { engine: conversation, inbox: calendarInbox } of calendar.conversations) {
          const proposal = conversation.state.proposal;
          if (!proposal?.approvedAt) continue;
          await Promise.allSettled([discord.poll(proposal, event => calendarInbox.receive(event)), zoom.poll(proposal, event => calendarInbox.receive(event))]);
        }
      }
      if (peers.state.enabled && ownerReady() && calendar.state.connected) {
        const receive = async (event: Parameters<ReplyInbox['receive']>[0]) => {
          if (!peers.state.enabled || event.quotedId) return;
          await peers.receive(event);
        };
        await Promise.allSettled([discord.pollRequests(peers.state.since, receive), zoom.pollRequests(peers.state.since, settings.coworkers, receive)]);
      }
    } finally { polling = false; }
  };
  const finishLegacyCounterproposal = async () => {
    if (engine.state.proposal?.approvedAt && ['waiting', 'attention'].includes(engine.state.phase) && engine.state.proposal.people.some(p => ['declined', 'counterproposal'].includes(p.status))) await engine.unresolved('This earlier scenario was not linked to a Calendar event. Continue in Plan my day to coordinate real calendar times.');
  };
  const start = () => {
    void model.check();
    if (discord.configured && !paused.discord) void connect('discord', () => discord.check()).catch(() => {});
    if (zoom.configured && !paused.zoom) void connect('zoom', () => zoom.check()).catch(() => {});
    if (settings.telegramToken && settings.telegramOwnerChatId && !paused.telegram) void connect('telegram', () => telegram.connect()).catch(() => {});
    const replyTimer = setInterval(() => void poll(), 6000); replyTimer.unref();
    const inboxTimer = setInterval(() => void inbox.drain().then(() => finishLegacyCounterproposal()).catch(() => { engine.state.error = 'A reply remains queued. Check local storage, then restart DayMade.'; }), 500); inboxTimer.unref();
    const calendarTimer = setInterval(() => void calendar.tick().then(() => peers.tick()).catch(() => {}), 3000); calendarTimer.unref();
    const travelTimer = setInterval(() => void travel.tick().catch(() => {}), 15000); travelTimer.unref();
    const modelTimer = setInterval(() => void model.check(), 30000); modelTimer.unref();
    return () => { clearInterval(travelTimer); clearInterval(calendarTimer); clearInterval(modelTimer); clearInterval(replyTimer); clearInterval(inboxTimer); telegram.stop(); tunnel.stop(); };
  };
  return { app, webhookApp, webhookPort, engine, model, telegram, discord, zoom, inbox, poll, tunnel, calendar, peers, travel, start };
}
