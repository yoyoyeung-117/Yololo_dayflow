import { randomBytes } from 'node:crypto';
import type { Proposal, Settings } from '../shared/types.js';
import type { Store } from './store.js';
import { SendFailure } from './transport.js';

type Update = { update_id: number; message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean }; reply_to_message?: { message_id: number } }; callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type?: string } } } };
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
  constructor(private settings: () => Settings, private saveOwner: (id: string) => void, private store: Store, private onAction: (action: string, id: string, value?: string) => Promise<void>, private http: typeof fetch = fetch) {
    this.offset = store.read('telegram-offset', 0);
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
  async send(text: string, proposal?: Proposal) {
    const settings = this.settings();
    if (!settings.telegramToken || !settings.telegramOwnerChatId) return;
    const keyboard = proposal ? { inline_keyboard: [[{ text: proposal.mode === 'live' ? 'Approve & send to coworkers' : 'Approve replay', callback_data: `approve:${proposal.id}` }], [{ text: 'Try 2:00 pm', callback_data: `time:${proposal.id}:14:00` }, { text: 'Try 2:15 pm', callback_data: `time:${proposal.id}:14:15` }, { text: 'Try 2:30 pm', callback_data: `time:${proposal.id}:14:30` }], [{ text: 'Dismiss', callback_data: `dismiss:${proposal.id}` }]] } : undefined;
    await this.api('sendMessage', { chat_id: settings.telegramOwnerChatId, text: text.slice(0, 4096), ...(keyboard ? { reply_markup: keyboard } : {}) });
  }
  async sendButtons(text: string, buttons: { text: string; callback_data: string }[][] = []) {
    const settings = this.settings();
    if (!settings.telegramOwnerChatId || !this.connected) throw new Error('Connect and pair Telegram first.');
    if (text.length > 4096) throw new Error('This plan is too long for Telegram. Review and approve the complete plan on your Mac.');
    await this.api('sendMessage', { chat_id: settings.telegramOwnerChatId, text, ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) });
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
        await this.send('Dayflow is connected. Your proposals, approval buttons and private progress updates will appear here. Coworker conversations stay on Discord and Zoom Team Chat.'); return;
      }

    }
    const callback = update.callback_query;
    if (!callback) return;
    const [action, id, ...value] = (callback.data || '').split(':');
    const owner = this.settings().telegramOwnerChatId;
    if (!owner || String(callback.from.id) !== owner || String(callback.message?.chat.id) !== owner) {
      await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: 'This action belongs to the paired owner.' }); return;
    }
    await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: 'Checking this proposal…' });
    try { await this.onAction(action, id, value.join(':')); }
    catch (error) { await this.send((error as Error).message); }
  }
}
