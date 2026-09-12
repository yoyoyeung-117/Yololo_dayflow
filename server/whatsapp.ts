import twilio from 'twilio';
import type { Settings, Proposal } from '../shared/types.js';
import type { Store } from './store.js';

export type WebhookFields = Record<string, string>;
export const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
export const stripChannel = (value: string) => value.replace(/^whatsapp:/, '');
const errorHints: Record<number, string> = {
  20003: 'Check your Account SID and Auth Token.',
  63015: 'This coworker must join your Twilio WhatsApp sandbox first.',
  63016: 'The 24-hour messaging window is closed. Ask this coworker to send hello again.',
  63007: 'Check the WhatsApp sender number in your Twilio testing environment.',
  21608: 'Verify this recipient in Twilio or check trial-account restrictions.',
  63003: 'Check the recipient’s WhatsApp phone number.',
};
export const deliveryHint = (code: number) => errorHints[code] || `Twilio reported error ${code}. Check Messaging logs in your Twilio console.`;
export class SendFailure extends Error {
  constructor(message: string, public definitive: boolean) { super(message); }
}

export function correlatedWhatsAppReply(fields: WebhookFields, proposal: Proposal): { personId: string; text: string; messageId: string } | null {
  const person = proposal.people.find(p => p.id === stripChannel(fields.From || ''));
  if (!person || !proposal.approvedAt || !fields.MessageSid || !fields.Body?.trim()) return null;
  const code = fields.Body.match(/#DF-[A-F0-9]{6}\b/gi)?.map(s => s.toUpperCase()) || [];
  // An explicitly different reference overrides any quoted context.
  if (code.some(c => c !== proposal.code)) return null;
  const quoted = Boolean(person.messageId && fields.OriginalRepliedMessageSid === person.messageId);
  if (!quoted && !code.includes(proposal.code)) return null;
  if (person.delivery === 'not_sent') return null;
  const text = fields.Body.replace(new RegExp(proposal.code, 'gi'), '').replace(/^\s*[:\-–]\s*/, '').trim();
  return text ? { personId: person.id, text, messageId: fields.MessageSid } : null;
}

export class WhatsApp {
  connected = false;
  error: string | null = null;
  private lastSendAt = 0;
  private inbound: Record<string, { at: number; sid: string }>;
  constructor(private settings: () => Settings, private store: Store, private http: typeof fetch = fetch, private pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
    this.inbound = store.read('whatsapp-inbound', {});
  }
  get configured() { const s = this.settings(); return Boolean(s.twilioAccountSid && s.twilioAuthToken); }
  urls() { const base = this.settings().whatsappWebhookBaseUrl; return { inboundUrl: base ? `${base}/webhooks/whatsapp/incoming` : '', statusUrl: base ? `${base}/webhooks/whatsapp/status` : '' }; }
  private windowKey(phone: string) { const s = this.settings(); return `${s.twilioAccountSid}:${s.whatsappFrom}:${phone}`; }
  recipients() {
    return this.settings().whatsappRecipients.map(p => {
      const lastInboundAt = this.inbound[this.windowKey(p.phone)]?.at || null;
      return { ...p, lastInboundAt, windowOpen: Boolean(lastInboundAt && Date.now() - lastInboundAt < 23 * 60 * 60_000 + 55 * 60_000) };
    });
  }
  get ready() { const recipients = this.recipients(); return this.connected && Boolean(this.urls().inboundUrl) && recipients.length > 0 && recipients.every(p => p.windowOpen); }
  invalidate() { this.connected = false; this.error = null; }
  observeInbound(fields: WebhookFields, at: number) {
    const phone = stripChannel(fields.From || '');
    if (!this.settings().whatsappRecipients.some(p => p.phone === phone)) return;
    const key = this.windowKey(phone);
    if (this.inbound[key]?.sid === fields.MessageSid) return;
    this.inbound[key] = { at, sid: fields.MessageSid }; this.store.write('whatsapp-inbound', this.inbound);
  }
  validate(path: string, signature: string, fields: WebhookFields) {
    const s = this.settings();
    if (!s.twilioAuthToken || !s.whatsappWebhookBaseUrl || fields.AccountSid !== s.twilioAccountSid) return false;
    if (path === '/webhooks/whatsapp/incoming' && fields.To !== `whatsapp:${s.whatsappFrom}`) return false;
    try { return twilio.validateRequest(s.twilioAuthToken, signature, `${s.whatsappWebhookBaseUrl}${path}`, fields); } catch { return false; }
  }
  private auth() { const s = this.settings(); return `Basic ${Buffer.from(`${s.twilioAccountSid}:${s.twilioAuthToken}`).toString('base64')}`; }
  async check() {
    if (!this.configured) throw new Error('Add your Twilio Account SID and Auth Token first.');
    try {
      const s = this.settings();
      const response = await this.http(`https://api.twilio.com/2010-04-01/Accounts/${s.twilioAccountSid}.json`, { headers: { Authorization: this.auth() }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Twilio credentials could not be verified. Check Account SID and Auth Token in your Twilio console.');
      const account = await response.json() as { sid?: string; status?: string };
      if (account.sid !== s.twilioAccountSid || account.status !== 'active') throw new Error('This Twilio account is not active. Check your console.');
      this.connected = true; this.error = null;
    } catch (error) { this.connected = false; this.error = error instanceof Error ? error.message : 'Twilio could not be reached.'; throw new Error(this.error); }
  }
  async destination() {
    if (!this.connected) throw new Error('Save and verify your Twilio credentials in Connections.');
    if (!this.urls().inboundUrl) throw new Error('Start the WhatsApp reply connection and set its URL in Twilio.');
    const people = this.recipients();
    if (!people.length) throw new Error('Add at least one coworker’s WhatsApp number in Connections.');
    const missing = people.filter(p => !p.windowOpen);
    if (missing.length) throw new Error(`Ask ${missing.map(p => p.name).join(', ')} to join the Twilio sandbox and send hello. Dayflow must receive that message before sending a proposal.`);
    const s = this.settings();
    return { destinationId: `${s.twilioAccountSid}:${s.whatsappFrom}`, destinationName: 'Coworkers · individual WhatsApp messages', people: people.map(p => ({ id: p.phone, name: p.name })) };
  }
  async send(phone: string, text: string) {
    if (!PHONE_PATTERN.test(phone)) throw new SendFailure('Invalid recipient phone number.', true);
    // Twilio sandbox permits one outbound message every three seconds.
    const wait = Math.max(0, 3100 - (Date.now() - this.lastSendAt)); if (wait) await this.pause(wait);
    this.lastSendAt = Date.now();
    const s = this.settings();
    const body = new URLSearchParams({ From: `whatsapp:${s.whatsappFrom}`, To: `whatsapp:${phone}`, Body: text, StatusCallback: this.urls().statusUrl });
    let response: Response;
    try { response = await this.http(`https://api.twilio.com/2010-04-01/Accounts/${s.twilioAccountSid}/Messages.json`, { method: 'POST', headers: { Authorization: this.auth(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(15000) }); }
    catch { throw new SendFailure('Twilio did not confirm the send. Check Messaging logs before trying again.', false); }
    const data = await response.json().catch(() => ({})) as { sid?: string; status?: string; date_created?: string; code?: number };
    if (!response.ok) throw new SendFailure(deliveryHint(data.code || response.status), response.status >= 400 && response.status < 500);
    if (!data.sid || !/^SM[0-9a-f]{32}$/i.test(data.sid)) throw new SendFailure('Twilio returned an unexpected response. Check Messaging logs before trying again.', false);
    return { id: data.sid, createdDateTime: data.date_created || new Date().toISOString() };
  }
}
