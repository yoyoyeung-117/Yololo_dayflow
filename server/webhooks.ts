import express from 'express';
import type { Engine } from './engine.js';
import { correlatedWhatsAppReply, type WhatsApp, type WebhookFields } from './whatsapp.js';
import type { Store } from './store.js';

type InboxEvent = { key: string; kind: 'incoming' | 'status'; fields: WebhookFields; at: number; proposalId?: string };

export function createWebhookApp(whatsapp: WhatsApp, engine: Engine, store: Store) {
  const app = express(); app.disable('x-powered-by');
  const inbox = store.read<InboxEvent[]>('whatsapp-inbox', []);
  const seen = store.read<string[]>('whatsapp-seen', []);
  let processing = false;
  const drain = async () => {
    if (processing) return;
    processing = true;
    try {
      while (inbox.length) {
        if (engine.state.phase === 'sending') break;
        const event = inbox[0];
        if (engine.state.proposal?.id === event.proposalId) {
          if (event.kind === 'incoming' && engine.state.proposal) {
            const reply = correlatedWhatsAppReply(event.fields, engine.state.proposal);
            if (reply) await engine.reply(event.proposalId!, reply.personId, reply.text, reply.messageId);
          } else if (event.kind === 'status') await engine.deliveryStatus(event.fields.MessageSid, event.fields.MessageStatus, event.fields.ErrorCode);
        }
        inbox.shift(); store.write('whatsapp-inbox', inbox);
      }
    } catch { engine.state.error = 'A WhatsApp reply is queued but could not be processed. Check local storage and the model, then restart Dayflow.'; }
    finally { processing = false; }
  };
  app.use(express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 100 }));
  for (const kind of ['incoming', 'status'] as const) {
    const route = `/webhooks/whatsapp/${kind}`;
    app.post(route, (req, res) => {
      const fields = req.body as WebhookFields;
      if (!req.is('application/x-www-form-urlencoded') || !fields || Object.values(fields).some(value => typeof value !== 'string')) return res.sendStatus(400);
      if (req.originalUrl !== route || !whatsapp.validate(route, req.get('X-Twilio-Signature') || '', fields)) return res.sendStatus(403);
      if (!/^SM[0-9a-f]{32}$/i.test(fields.MessageSid || '')) return res.sendStatus(400);
      const key = `${kind}:${fields.MessageSid}:${kind === 'status' ? fields.MessageStatus : ''}`;
      if (!seen.includes(key)) {
        if (inbox.length >= 2000) return res.sendStatus(503);
        const at = Date.now();
        if (kind === 'incoming') whatsapp.observeInbound(fields, at);
        inbox.push({ key, kind, fields, at, proposalId: engine.state.proposal?.id });
        // Persist before acknowledging. Model inference and Telegram notifications happen after the HTTP response.
        store.write('whatsapp-inbox', inbox);
        seen.push(key); if (seen.length > 10000) seen.splice(0, seen.length - 10000);
        store.write('whatsapp-seen', seen);
      }
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      setImmediate(() => void drain());
    });
  }
  // This app exposes neither the dashboard nor its administrative API.
  app.use((_req, res) => { res.sendStatus(404); });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.sendStatus(500); });
  const start = () => { const timer = setInterval(() => void drain(), 1000); timer.unref(); return () => clearInterval(timer); };
  return { app, drain, start };
}
