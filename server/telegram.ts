import { randomBytes } from 'node:crypto';
import type { Person, Proposal, Settings } from '../shared/types.js';
import type { Store } from './store.js';
import { SendFailure, type Incoming } from './transport.js';

type Update = { update_id: number; message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean }; reply_to_message?: { message_id: number } }; callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type?: string } } } };
type Invite = { code: string; expiresAt: number };
type CoworkerHooks = { claim: (id: string, chatId: string) => void; incoming: (event: Incoming) => Promise<void>; answer: (proposalId: string, sender: string, choice: string, callbackId: string, quotedId: string) => Promise<void> };

export class Telegram {
  username: string | null = null;
  connected = false;
  pairingCode: string | null = null;
  private pairingExpiresAt = 0;
  error: string | null = null;
  private running = false;
  private stopped = false;
  private offset: number;
  private controller = new AbortController();
  private invitations: Record<string, Invite>;
  constructor(private settings: () => Settings, private saveOwner: (id: string) => void, private store: Store, private onAction: (action: string, id: string, value?: string) => Promise<void>, private coworkers?: CoworkerHooks, private http: typeof fetch = fetch) {
    this.offset = store.read('telegram-offset', 0);
    this.invitations = store.read('telegram-invites', {});
  }
  private async api<T>(method: string, body: object, timeout = 12000): Promise<T> {
    const token = this.settings().telegramToken;
    if (!token) throw new SendFailure('Add a Telegram bot token.', true);
    let response: Response;
    try { response = await this.http(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeout), this.controller.signal]) }); }
    catch { throw new SendFailure('Telegram did not confirm the request. Check your connection and the chat before sending again.', false); }
    const result = await response.json().catch(() => ({})) as { ok: boolean; result: T; error_code?: number };
    if (!response.ok || !result.ok) throw new SendFailure(`Telegram ${method} failed (${result.error_code || response.status}). Check the bot token, chat access, and whether another bot process or webhook is active.`, response.status >= 400 && response.status < 500);
    return result.result;
  }
  async connect() {
    try {
      const me = await this.api<{ username: string }>('getMe', {});
      const webhook = await this.api<{ url: string }>('getWebhookInfo', {});
      if (webhook.url) throw new Error('This bot already has a webhook. Use a dedicated bot for Dayflow.');
      this.username = me.username; this.error = null; this.connected = true;
      if (!this.settings().telegramOwnerChatId) { this.pairingCode = randomBytes(8).toString('hex'); this.pairingExpiresAt = Date.now() + 10 * 60_000; }
      this.start();
    } catch (error) { this.connected = false; this.error = (error as Error).message; throw error; }
  }
  invite(personId: string) {
    if (!this.connected || !this.username || !this.settings().telegramOwnerChatId) throw new Error('Connect and pair your Telegram owner account first.');
    const person = this.settings().coworkers.find(p => p.id === personId && p.platform === 'telegram');
    if (!person || person.address) throw new Error('Choose a Telegram coworker who has not joined yet.');
    this.invitations[personId] = { code: `join_${randomBytes(12).toString('hex')}`, expiresAt: Date.now() + 30 * 60_000 };
    this.store.write('telegram-invites', this.invitations);
    return this.invitation(personId);
  }
  invitation(personId: string) {
    const invite = this.invitations[personId];
    if (!invite || invite.expiresAt <= Date.now() || !this.username) return {};
    return { inviteUrl: `https://t.me/${this.username}?start=${invite.code}`, inviteExpiresAt: invite.expiresAt };
  }
  async send(text: string, proposal?: Proposal) {
    const settings = this.settings();
    if (!settings.telegramToken || !settings.telegramOwnerChatId) return;
    const keyboard = proposal ? { inline_keyboard: [[{ text: proposal.mode === 'live' ? 'Approve & send to coworkers' : 'Approve replay', callback_data: `approve:${proposal.id}` }], [{ text: 'Try 2:00 pm', callback_data: `time:${proposal.id}:14:00` }, { text: 'Try 2:15 pm', callback_data: `time:${proposal.id}:14:15` }, { text: 'Try 2:30 pm', callback_data: `time:${proposal.id}:14:30` }], [{ text: 'Dismiss', callback_data: `dismiss:${proposal.id}` }]] } : undefined;
    await this.api('sendMessage', { chat_id: settings.telegramOwnerChatId, text: text.slice(0, 4096), ...(keyboard ? { reply_markup: keyboard } : {}) });
  }
  async sendProposal(person: Person, proposal: Proposal) {
    if (!person.address || person.address === this.settings().telegramOwnerChatId) throw new SendFailure('This coworker must join through their own Telegram invitation.', true);
    const keyboard = { inline_keyboard: [[{ text: 'Accept', callback_data: `reply:${proposal.id}:yes` }, { text: 'Cannot attend', callback_data: `reply:${proposal.id}:no` }]] };
    const result = await this.api<{ message_id: number }>('sendMessage', { chat_id: person.address, text: `Dayflow · Meeting proposal\n\n${proposal.text}`, reply_markup: keyboard });
    if (!result.message_id) throw new SendFailure('Telegram returned no message receipt. Check the chat before sending again.', false);
    return { id: String(result.message_id), createdDateTime: new Date().toISOString(), delivery: 'sent' as const };
  }
  stop() { this.stopped = true; this.connected = false; this.controller.abort(); }
  start() {
    this.stopped = false;
    if (this.running) return;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.running = true;
    void this.loop().finally(() => { this.running = false; });
  }
  private async loop() {
    while (!this.stopped) {
      try {
        const updates = await this.api<Update[]>('getUpdates', { offset: this.offset, timeout: 20, allowed_updates: ['message', 'callback_query'] }, 26000);
        if (this.stopped) break;
        this.connected = true; this.error = null;
        for (const update of updates) {
          if (this.stopped) break;
          try { await this.handle(update); }
          catch (error) { this.error = (error as Error).message; }
          this.offset = update.update_id + 1; this.store.write('telegram-offset', this.offset);
        }
      } catch (error) {
        if (this.stopped) break;
        this.connected = false; this.error = (error as Error).message;
        await new Promise(resolve => { const timer = setTimeout(resolve, 4000); timer.unref(); });
      }
    }
  }
  private async handle(update: Update) {
    const message = update.message;
    const privateMessage = message?.chat.type === 'private' && message.from?.id === message.chat.id && !message.from?.is_bot;
    if (message && privateMessage) {
      if (!this.settings().telegramOwnerChatId && this.pairingCode && Date.now() < this.pairingExpiresAt && message.text === `/start ${this.pairingCode}`) {
        this.saveOwner(String(message.chat.id)); this.pairingCode = null;
        await this.send('Dayflow is connected. Your proposals and approval buttons will appear here. Coworkers use separate invitation links.'); return;
      }
      const invitation = Object.entries(this.invitations).find(([, invite]) => invite.expiresAt > Date.now() && message.text === `/start ${invite.code}`);
      if (invitation && this.coworkers) {
        const sender = String(message.chat.id);
        try {
          if (sender === this.settings().telegramOwnerChatId) throw new Error('This invitation is for a coworker. Share it with their Telegram account.');
          this.coworkers.claim(invitation[0], sender);
          delete this.invitations[invitation[0]]; this.store.write('telegram-invites', this.invitations);
          await this.api('sendMessage', { chat_id: sender, text: 'You joined Dayflow as a meeting participant. Requests will appear here. Tap Accept or reply to a proposal to suggest another time.' });
        } catch (error) { await this.api('sendMessage', { chat_id: sender, text: (error as Error).message }); }
        return;
      }
      if (message.text && this.coworkers) await this.coworkers.incoming({ platform: 'telegram', sender: String(message.chat.id), text: message.text, messageId: `${message.chat.id}:${message.message_id}`, quotedId: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined, at: message.date * 1000 });
    }
    const callback = update.callback_query;
    if (!callback) return;
    const [action, id, ...value] = (callback.data || '').split(':');
    if (action === 'reply') {
      if (!this.coworkers || String(callback.from.id) !== String(callback.message?.chat.id) || callback.message?.chat.type !== 'private') {
        await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: 'Open your own private meeting request.' }); return;
      }
      await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: 'Checking your response…' });
      try { await this.coworkers.answer(id, String(callback.from.id), value.join(':'), callback.id, String(callback.message!.message_id)); }
      catch (error) { await this.api('sendMessage', { chat_id: callback.from.id, text: (error as Error).message }); }
      return;
    }
    const owner = this.settings().telegramOwnerChatId;
    if (!owner || String(callback.from.id) !== owner || String(callback.message?.chat.id) !== owner) {
      await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: 'This action belongs to the paired owner.' }); return;
    }
    await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: 'Checking this proposal…' });
    try { await this.onAction(action, id, value.join(':')); }
    catch (error) { await this.send((error as Error).message); }
  }
}
