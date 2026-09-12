import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Person, Proposal, Settings } from '../shared/types.js';
import type { Store } from './store.js';
import { SendFailure, type Incoming } from './transport.js';

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; clientId: string; account: string; userId: string };
type ZoomMessage = { id: string; message?: string; sender?: string; timestamp?: number; date_time?: string; reply_main_message_id?: string };
export class Zoom {
  connected = false;
  error: string | null = null;
  private tokens: Tokens | null;
  private pending: { state: string; expiresAt: number; redirectUrl: string; clientId: string } | null = null;
  private refreshing: Promise<void> | null = null;
  private cooldown = 0;
  constructor(private settings: () => Settings, private store: Store, private http: typeof fetch = fetch) { this.tokens = store.read<Tokens | null>('zoom-tokens', null); }
  get configured() { const s = this.settings(); return Boolean(s.zoomClientId && s.zoomClientSecret); }
  get account() { return this.connected ? this.tokens?.account || null : null; }
  get userId() { return this.tokens?.userId || ''; }
  get redirectUrl() { return this.settings().zoomRedirectBaseUrl ? `${this.settings().zoomRedirectBaseUrl}/oauth/zoom/callback` : ''; }
  invalidate() { this.connected = false; this.error = null; this.pending = null; this.tokens = null; this.store.write('zoom-tokens', null); }
  authorizeUrl() {
    if (!this.configured || !this.redirectUrl) throw new Error('Save Zoom client credentials and start its authorization connection first.');
    this.pending = { state: randomBytes(32).toString('hex'), expiresAt: Date.now() + 10 * 60_000, redirectUrl: this.redirectUrl, clientId: this.settings().zoomClientId };
    return `https://zoom.us/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: this.pending.clientId, redirect_uri: this.pending.redirectUrl, state: this.pending.state })}`;
  }
  async callback(code: string, state: string) {
    const pending = this.pending;
    const digest = (text: string) => createHash('sha256').update(text).digest();
    if (!pending || Date.now() > pending.expiresAt || !timingSafeEqual(digest(state), digest(pending.state)) || pending.clientId !== this.settings().zoomClientId || pending.redirectUrl !== this.redirectUrl) throw new Error('Zoom authorization expired or does not match. Start authorization again from Dayflow.');
    this.pending = null;
    if (!code || code.length > 2000) throw new Error('Zoom did not return an authorization code.');
    await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUrl });
    await this.check();
  }
  private async exchange(parameters: Record<string, string>) {
    const s = this.settings();
    let response: Response;
    try { response = await this.http('https://zoom.us/oauth/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${s.zoomClientId}:${s.zoomClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters).toString(), signal: AbortSignal.timeout(12000) }); }
    catch { throw new Error('Zoom authorization could not be reached. Start authorization again if the problem persists.'); }
    const data = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!response.ok || !data.access_token || !data.refresh_token) throw new Error('Zoom authorization failed. Check client credentials, the exact redirect URL and your app’s scopes; then authorize again.');
    this.tokens = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000, clientId: s.zoomClientId, account: this.tokens?.account || '', userId: this.tokens?.userId || '' };
    this.store.write('zoom-tokens', this.tokens);
  }
  private async token() {
    if (!this.tokens || this.tokens.clientId !== this.settings().zoomClientId) throw new SendFailure('Authorize Zoom from Connections first.', true);
    if (this.tokens.expiresAt < Date.now() + 60000) {
      if (!this.refreshing) this.refreshing = this.exchange({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken }).finally(() => { this.refreshing = null; });
      try { await this.refreshing; } catch { this.connected = false; throw new SendFailure('Zoom authorization expired. Reconnect Zoom before sending.', true); }
    }
    return this.tokens!.accessToken;
  }
  private async api<T>(route: string, body?: object): Promise<T> {
    if (Date.now() < this.cooldown) throw new SendFailure('Zoom rate limit is cooling down. Wait before trying again.', true);
    const token = await this.token();
    let response: Response;
    try { response = await this.http(`https://api.zoom.us/v2${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) }); }
    catch { throw new SendFailure('Zoom did not confirm the request. Check Team Chat before sending again.', false); }
    if (response.status === 429) this.cooldown = Date.now() + Math.max(10000, Math.min(300000, Number(response.headers.get('Retry-After')) * 1000 || 30000));
    if (response.status === 401) this.connected = false;
    if (!response.ok) throw new SendFailure(`Zoom request failed (${response.status}). Check the user-level Team Chat scopes, app authorization and contact access. Your organization may require app approval.`, response.status >= 400 && response.status < 500);
    return await response.json() as T;
  }
  async check() {
    try {
      const me = await this.api<{ id: string; email: string }>('/users/me');
      if (!me.id || !me.email) throw new Error('Zoom did not return your account identity. Add user:read:user scope.');
      this.tokens!.account = me.email; this.tokens!.userId = me.id; this.store.write('zoom-tokens', this.tokens);
      this.connected = true; this.error = null;
    } catch (error) { this.connected = false; this.error = (error as Error).message; throw error; }
  }
  async checkContact(email: string) {
    if (email.toLowerCase() === this.account?.toLowerCase()) throw new Error('Choose a coworker’s Zoom contact email, not your own account.');
    // Read-only check that the authorized user can access this contact conversation.
    await this.api(`/chat/users/me/messages?${new URLSearchParams({ to_contact: email, page_size: '1' })}`);
  }
  async sendProposal(person: Person, proposal: Proposal) {
    if (!this.connected || !person.address) throw new SendFailure('Authorize Zoom and add a Team Chat contact email first.', true);
    const result = await this.api<{ id: string; date_time?: string }>('/chat/users/me/messages', { to_contact: person.address, message: `Dayflow · Meeting proposal\n\n${proposal.text}` });
    if (!result.id) throw new SendFailure('Zoom returned no message receipt. Check Team Chat before sending again.', false);
    return { id: result.id, createdDateTime: result.date_time || new Date().toISOString(), delivery: 'sent' as const };
  }
  async poll(proposal: Proposal, receive: (event: Incoming) => Promise<void>) {
    if (!this.connected || Date.now() < this.cooldown) return;
    try {
      for (const person of proposal.people.filter(p => p.platform === 'zoom' && p.messageId && p.address)) {
        let next = '';
        for (let page = 0; page < 5; page++) {
          const query = new URLSearchParams({ to_contact: person.address!, page_size: '100', from: new Date(proposal.sentAt! - 1000).toISOString(), to: new Date().toISOString() });
          if (next) query.set('next_page_token', next);
          const data = await this.api<{ messages?: ZoomMessage[]; next_page_token?: string }>(`/chat/users/me/messages?${query}`);
          const messages = data.messages || [];
          messages.sort((a, b) => (a.timestamp || Date.parse(a.date_time || '')) - (b.timestamp || Date.parse(b.date_time || '')));
          for (const message of messages) {
            if (message.sender?.toLowerCase() !== person.address!.toLowerCase() || message.sender?.toLowerCase() === this.account?.toLowerCase()) continue;
            await receive({ platform: 'zoom', sender: message.sender, text: message.message || '', messageId: message.id, quotedId: message.reply_main_message_id, at: message.timestamp || Date.parse(message.date_time || '') });
          }
          next = data.next_page_token || '';
          if (!next) break;
        }
        if (next) throw new Error('Zoom has more than 500 messages in this conversation since the proposal. Use a quiet demo conversation; some replies may not be processed.');
      }
      this.error = null;
    } catch (error) { this.error = (error as Error).message; }
  }
}
