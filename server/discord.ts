import type { Coworker, Person, Proposal, Settings } from '../shared/types.js';
import type { Store } from './store.js';
import { SendFailure, type Incoming } from './transport.js';

export type DiscordMessage = { id: string; content: string; author: { id: string; bot?: boolean }; timestamp: string; message_reference?: { message_id?: string } };
const MESSAGE_CONTENT = (1 << 18) | (1 << 19);
const LIMITED_MESSAGE_CONTENT = 1 << 19;
const EDITABLE_INTENTS = (1 << 13) | (1 << 15) | LIMITED_MESSAGE_CONTENT;
export class Discord {
  connected = false;
  error: string | null = null;
  botId = '';
  botName: string | null = null;
  channelName: string | null = null;
  private cooldown = 0;
  private cursors: Record<string, string>;
  constructor(private settings: () => Settings, private store: Store, private http: typeof fetch = fetch) { this.cursors = store.read('discord-cursors', {}); }
  get configured() { const s = this.settings(); return Boolean(s.discordToken && s.discordChannelId); }
  invalidate() { this.connected = false; this.error = null; this.botId = ''; this.channelName = null; }
  private async api<T>(route: string, body?: object, method = body ? 'POST' : 'GET'): Promise<T> {
    if (Date.now() < this.cooldown) throw new SendFailure('Discord rate limit is cooling down. Wait before trying again.', true);
    let response: Response;
    try { response = await this.http(`https://discord.com/api/v10${route}`, { method, headers: { Authorization: `Bot ${this.settings().discordToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) }); }
    catch { throw new SendFailure('Discord did not confirm the request. Check the channel before sending again.', false); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 429) this.cooldown = Date.now() + Math.max(1000, Math.min(300000, Number(data.retry_after) * 1000 || 10000));
    if (!response.ok) throw new SendFailure(`Discord request failed (${response.status}). Check the bot token, channel ID, View Channel, Send Messages and Read Message History permissions.`, response.status >= 400 && response.status < 500);
    return data as T;
  }
  async check() {
    if (!this.configured) throw new Error('Add the Discord bot token and channel ID first.');
    try {
      const me = await this.api<{ id: string; username: string; bot: boolean }>('/users/@me');
      if (!me.bot) throw new Error('Use a Discord bot token, not a personal account token.');
      const channel = await this.api<{ id: string; name: string; type: number; guild_id?: string }>(`/channels/${this.settings().discordChannelId}`);
      if (channel.type !== 0 || !channel.guild_id) throw new Error('Choose a regular text channel in your demo Discord server.');
      await this.api(`/channels/${channel.id}/messages?limit=1`);
      // Discord also gates REST message content on this intent, including replies without a mention.
      // https://docs.discord.com/developers/resources/application#edit-current-application
      let application = await this.api<{ flags?: number }>('/applications/@me');
      if (!Number.isInteger(application.flags)) throw new Error('Discord did not return its Message Content Intent settings. Reconnect to check again.');
      if (!(application.flags! & MESSAGE_CONTENT)) {
        try {
          application = await this.api('/applications/@me', { flags: (application.flags! & EDITABLE_INTENTS) | LIMITED_MESSAGE_CONTENT }, 'PATCH');
        } catch (error) {
          throw new Error(`Could not enable replies without @bot mentions. Enable Message Content Intent in Discord Developer Portal → Bot (request Discord approval if required), then reconnect. ${(error as Error).message}`);
        }
        if (!Number.isInteger(application.flags) || !(application.flags! & MESSAGE_CONTENT)) throw new Error('Discord has not enabled Message Content Intent. Enable it in Developer Portal → Bot (request Discord approval if required), then reconnect so coworkers can reply without @bot mentions.');
      }
      this.botId = me.id; this.botName = me.username; this.channelName = channel.name; this.connected = true; this.error = null;
    } catch (error) { this.connected = false; this.error = (error as Error).message; throw error; }
  }
  async sendProposal(person: Person, proposal: Proposal) {
    if (!this.connected || !person.address || !/^\d{15,22}$/.test(person.address)) throw new SendFailure('Connect Discord and enter this coworker’s user ID first.', true);
    const result = await this.api<{ id: string; timestamp: string }>(`/channels/${this.settings().discordChannelId}/messages`, { content: `<@${person.address}> · DayMade meeting proposal\n\n${proposal.text}`, allowed_mentions: { parse: [], users: [person.address], replied_user: false } });
    if (!result.id) throw new SendFailure('Discord returned no message receipt. Check the channel before sending again.', false);
    return { id: result.id, createdDateTime: result.timestamp || new Date().toISOString(), delivery: 'sent' as const };
  }
  async sendText(person: Coworker, text: string) {
    if (!this.connected || !/^\d{15,22}$/.test(person.address)) throw new SendFailure('Reconnect Discord first.', true);
    const result = await this.api<{ id: string }>(`/channels/${this.settings().discordChannelId}/messages`, { content: `<@${person.address}> · DayMade\n${text}`.slice(0, 2000), allowed_mentions: { parse: [], users: [person.address] } });
    if (!result.id) throw new SendFailure('Discord returned no receipt. No automatic retry.', false);
  }
  async pollRequests(since: number, receive: (event: Incoming) => Promise<void>) {
    if (!this.connected || Date.now() < this.cooldown) return;
    const key = `requests:${this.settings().discordChannelId}:${since}`;
    this.cursors[key] ||= ((BigInt(Math.max(0, since - 1420070400000))) << 22n).toString();
    try {
      for (let page = 0; page < 5; page++) {
        const messages = await this.api<DiscordMessage[]>(`/channels/${this.settings().discordChannelId}/messages?limit=100&after=${this.cursors[key]}`);
        if (!Array.isArray(messages)) throw new Error('Discord returned an unexpected message list.');
        messages.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        for (const message of messages) {
          if (!this.connected) return;
          if (!message.author.bot) await receive({ platform: 'discord', sender: message.author.id, text: message.content || '', messageId: message.id, quotedId: message.message_reference?.message_id, at: Date.parse(message.timestamp) });
          this.cursors[key] = message.id; this.store.write('discord-cursors', this.cursors);
        }
        if (messages.length < 100) break;
      }
      this.error = null;
    } catch (error) { this.error = (error as Error).message; }
  }
  async poll(proposal: Proposal, receive: (event: Incoming) => Promise<void>) {
    if (!this.connected || Date.now() < this.cooldown) return;
    const receipts = proposal.people.filter(p => p.platform === 'discord' && p.messageId).map(p => p.messageId!).filter(id => /^\d+$/.test(id));
    if (!receipts.length) return;
    this.cursors[proposal.id] ||= receipts.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
    try {
      for (let page = 0; page < 5; page++) {
        const messages = await this.api<DiscordMessage[]>(`/channels/${this.settings().discordChannelId}/messages?limit=100&after=${this.cursors[proposal.id]}`);
        if (!Array.isArray(messages)) throw new Error('Discord returned an unexpected message list.');
        messages.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        for (const message of messages) {
          if (!message.author.bot) await receive({ platform: 'discord', sender: message.author.id, text: message.content || '', messageId: message.id, quotedId: message.message_reference?.message_id, at: Date.parse(message.timestamp) });
          this.cursors[proposal.id] = message.id; this.store.write('discord-cursors', this.cursors);
        }
        this.error = null;
        if (messages.length < 100) break;
      }
    } catch (error) { this.error = (error as Error).message; }
  }
}
