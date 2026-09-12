import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CalendarSnapshot, DayPlan, EventRule } from '../shared/calendar.js';
import { calendarRange, calendarTime } from '../shared/calendar.js';
import type { CalendarBridge } from './calendar-bridge.js';
import { Engine, type EngineDependencies } from './engine.js';
import { ReplyInbox } from './inbox.js';
import { Store } from './store.js';
import { planDay } from './day-planner.js';
import { recipientLabel } from './transport.js';

type Button = { text: string; callback_data: string };
type Checkin = { id: string; eventId: string; end: number; expiresAt: number; done: boolean };
export class CalendarAgent {
  state: CalendarSnapshot;
  conversations: { engine: Engine; inbox: ReplyInbox }[] = [];
  private busy = false;
  private monitorSince: number;
  private checkins: Checkin[];
  constructor(private store: Store, private bridge: CalendarBridge, private deps: Omit<EngineDependencies, 'save'>, private owner: (text: string, buttons?: Button[][]) => Promise<void>, private legacyActive: () => boolean, private now = Date.now) {
    this.state = store.read<CalendarSnapshot>('calendar-state', { connected: false, error: null, notificationError: null, day: null, rules: {}, monitoring: false, plan: null, refreshedAt: null });
    this.monitorSince = now(); this.checkins = store.read('calendar-checkins', []);
    if (this.state.plan?.status === 'applying') { this.state.plan.status = 'uncertain'; this.state.plan.error = 'Dayflow restarted during a calendar save. Check Calendar before creating another plan.'; }
    else if (this.state.plan?.status === 'coordinating') { this.state.plan.status = 'attention'; this.state.plan.error = 'Dayflow restarted while coordinating. Review the recorded replies and messages, then stop this plan and prepare a fresh one. No automatic resend or calendar save will run.'; }
    this.restoreConversations(); this.save();
  }
  get active() { return this.busy || ['coordinating', 'applying', 'attention', 'uncertain'].includes(this.state.plan?.status || ''); }
  private save() { this.store.write('calendar-state', this.state); }
  private async exclusive<T>(fn: () => Promise<T>) { if (this.busy) throw new Error('Wait for the current Calendar action to finish.'); this.busy = true; try { return await fn(); } finally { this.busy = false; } }
  private async notify(text: string, buttons?: Button[][]) { try { await this.owner(text, buttons); this.state.notificationError = null; } catch (e) { this.state.notificationError = (e as Error).message; } this.save(); }
  private restoreConversations() {
    this.conversations = [];
    const plan = this.state.plan; if (!plan) return;
    plan.changes.forEach((change, index) => {
      if (!change.personIds.length) return;
      const engine = new Engine({ ...this.deps, save: state => { change.conversation = state; this.save(); } }, change.conversation);
      const inbox = new ReplyInbox(engine, new Store(path.join(this.store.directory, 'calendar-inboxes', plan.id, String(index))));
      this.conversations.push({ engine, inbox });
    });
  }
  private async read(connect = false) {
    try { const day = await this.bridge.read(connect); this.state.day = day; this.state.connected = true; this.state.error = null; this.state.refreshedAt = this.now(); this.save(); return day; }
    catch (e) { this.state.connected = false; this.state.error = (e as Error).message; this.save(); throw e; }
  }
  refresh(connect = false) { return this.exclusive(() => this.read(connect)); }
  configure(monitoring: boolean) { if (this.busy) throw new Error('Wait for the current action.'); if (monitoring && !this.state.connected) throw new Error('Connect Apple Calendar first.'); this.state.monitoring = monitoring; this.monitorSince = this.now(); this.save(); }
  rule(eventId: string, rule: EventRule) {
    if (this.active) throw new Error('Stop the active plan before changing its event rules.');
    const event = this.state.day?.events.find(e => e.id === eventId);
    if (!event || (rule.flexible && !event.editable)) throw new Error('Only editable personal events can be flexible. Invites and read-only events stay fixed.');
    this.state.rules[eventId] = rule;
    if (this.state.plan?.status === 'draft') { this.state.plan.status = 'dismissed'; this.state.plan.error = 'Event rules changed. Build a fresh plan.'; }
    this.save();
  }
  async preview(eventId: string, extraMinutes: number, bufferMinutes = 10) {
    if (this.active || this.legacyActive()) throw new Error('Finish or stop the active conversation before building a calendar plan.');
    return this.exclusive(async () => {
      const day = await this.read();
      const plan = planDay(day, this.state.rules, eventId, extraMinutes, bufferMinutes, this.now());
      this.state.plan = plan; this.restoreConversations();
      try {
        for (const { engine } of this.conversations) {
          const change = plan.changes.find(c => c.conversation === engine.state)!;
          await engine.prepareCalendar(plan, change);
        }
      } catch (e) { plan.blockers.push((e as Error).message); }
      this.save();
      if (!plan.blockers.length && plan.changes.length) await this.notifyPlan();
      else await this.notify(`Dayflow · Calendar review\n${plan.blockers.length ? plan.blockers.join('\n') : 'Your remaining schedule has enough room. No later event needs to move.'}`);
      return plan;
    });
  }
  async notifyPlan() {
    const p = this.state.plan;
    if (!p || p.status !== 'draft' || p.blockers.length || !p.changes.length || p.expiresAt <= this.now()) throw new Error('Build a current, unblocked calendar plan first.');
    const detail = p.changes.map(c => `${c.event.title.slice(0, 140)}: ${calendarRange(c.event.start, c.event.end, p.timezone)} → ${calendarRange(c.start, c.end, p.timezone)}\n${c.conversation?.proposal ? `To: ${c.conversation.proposal.people.map(recipientLabel).join(', ')} in ${c.conversation.proposal.destinationName}\nMessage: ${c.conversation.proposal.text}` : 'Personal event: calendar change only; no messages.'}`).join('\n\n');
    const text = `Dayflow · LIVE CALENDAR PLAN · ${p.day} (${p.timezone})\n\nYou expect to finish “${p.source.title.slice(0, 140)}” at ${calendarTime(p.assumedEnd, p.timezone)}. Transition buffer: ${p.bufferMinutes} min.\n\n${detail}\n\nApprove these messages and calendar changes? I will save all changes only after every named friend agrees. Fixed events stay in place. Approval expires in 10 minutes.`;
    if (text.length > 4000) return this.notify('Dayflow · Your calendar plan is ready. It is too long to review in one Telegram message. Open My calendar on your Mac to review and approve every change.');
    await this.notify(text, [[{ text: 'Approve messages & calendar changes', callback_data: `dayapprove:${p.id}` }], [{ text: 'Dismiss', callback_data: `daydismiss:${p.id}` }]]);
  }
  async approve(id: string) {
    return this.exclusive(async () => {
      const p = this.state.plan;
      if (!p || p.id !== id || p.status !== 'draft' || p.blockers.length || !p.changes.length) throw new Error('This calendar approval is no longer active.');
      if (p.expiresAt <= this.now()) throw new Error('Approval expired. Build a fresh plan.');
      if (this.legacyActive()) throw new Error('Finish the practice conversation first.');
      const day = await this.read();
      if (day.revision !== p.revision || day.day !== p.day) throw new Error('Calendar changed. Build and approve a fresh plan.');
      if (p.changes.some(c => c.start <= this.now())) throw new Error('A proposed time has already passed. Build a fresh plan.');
      // Validate every destination before the first real send, then each Engine rechecks at send time.
      for (const { engine } of this.conversations) {
        const proposal = engine.state.proposal!;
        if (!proposal) throw new Error('A meeting proposal is missing. Build a fresh plan.');
        const current = await this.deps.destination(proposal.people.map(person => person.id));
        const identity = (people: typeof current.people) => JSON.stringify(people.map(p => [p.id, p.name, p.platform, p.address]).sort());
        if (current.destinationId !== proposal.destinationId || identity(current.people) !== identity(proposal.people)) throw new Error('A friend or messaging destination changed. Build a fresh plan.');
      }
      p.status = 'coordinating'; p.approvedAt = this.now(); this.save();
      try { for (const { engine } of this.conversations) await engine.approve(engine.state.proposal!.id); }
      catch (e) { p.status = 'attention'; p.error = (e as Error).message; this.save(); await this.notify(`Dayflow · Calendar plan paused\n${p.error}\nCheck the recorded deliveries. No automatic resend or calendar save.`); return; }
      await this.advance();
    });
  }
  dismiss(id: string) {
    if (this.busy) throw new Error('Wait for the current action to finish.');
    const p = this.state.plan; if (!p || p.id !== id || ['applied', 'dismissed'].includes(p.status)) throw new Error('This calendar plan is no longer active.');
    p.status = 'dismissed'; p.error = p.approvedAt ? 'Monitoring stopped. Already sent messages are not retracted. Check the conversations before creating another plan.' : undefined; this.save();
  }
  private async advance() {
    const p = this.state.plan; if (!p || p.status !== 'coordinating') return;
    if (this.conversations.some(c => ['attention', 'uncertain'].includes(c.engine.state.phase))) {
      p.status = 'attention'; p.error = 'A friend suggested another time, declined, or needs clarification. Review the replies, stop this plan, then prepare a fresh plan. Calendar is unchanged.'; this.save(); await this.notify(`Dayflow · Calendar plan paused\n${p.error}`); return;
    }
    if (this.now() - p.approvedAt! > 30 * 60_000 || p.changes.some(c => c.start <= this.now())) { p.status = 'attention'; p.error = 'This plan ran out of time while waiting. Review your day again; calendar is unchanged.'; this.save(); await this.notify(`Dayflow · ${p.error}`); return; }
    if (!this.conversations.every(c => c.engine.state.phase === 'agreed')) return;
    try {
      const day = await this.read();
      if (day.revision !== p.revision || day.day !== p.day) throw new Error('Your calendar changed while coordinating. Review a fresh plan before saving.');
    } catch (e) { p.status = 'attention'; p.error = (e as Error).message; this.save(); await this.notify(`Dayflow · Calendar not changed\n${p.error}`); return; }
    for (const { inbox } of this.conversations) await inbox.drain();
    if (!this.conversations.every(c => c.engine.state.phase === 'agreed')) return;
    p.status = 'applying'; this.save();
    try { p.receipts = await this.bridge.apply(p); p.status = 'applied'; p.appliedAt = this.now(); this.save(); }
    catch (e) { p.status = 'uncertain'; p.error = `${(e as Error).message} Inspect Apple Calendar before trying again. No automatic retry.`; this.save(); await this.notify(`Dayflow · Check Calendar\n${p.error}`); return; }
    await this.notify(`Dayflow · Calendar updated\n${p.changes.map(c => `${c.event.title.slice(0, 140)} → ${calendarRange(c.start, c.end, p.timezone)}`).join('\n')}\n${p.timezone}. Changes to iCloud calendars sync to your iPhone. Your current event’s stored end time was not changed.`);
    await this.read().catch(() => {});
  }
  async tick() {
    if (this.busy) return;
    await this.exclusive(async () => {
      if (this.state.plan && ['coordinating', 'attention'].includes(this.state.plan.status)) for (const { inbox } of this.conversations) await inbox.drain();
      await this.advance();
      if (!this.state.monitoring || (this.state.refreshedAt && this.now() - this.state.refreshedAt < 60_000)) return;
      const day = await this.read();
      const pending = this.state.plan;
      if (pending?.status === 'draft' && pending.expiresAt <= this.now()) { pending.status = 'dismissed'; pending.error = 'This review expired. Build a fresh plan.'; this.save(); }
      if (pending && (['coordinating', 'attention', 'uncertain', 'applying'].includes(pending.status) || (pending.status === 'draft' && (pending.changes.length > 0 || pending.blockers.length > 0)))) return;
      const now = this.now();
      this.checkins = this.checkins.filter(c => c.expiresAt > now - 24 * 60 * 60_000);
      const event = day.events.filter(e => !e.allDay && e.busy && e.end >= this.monitorSince && e.end <= now && e.end >= now - 10 * 60_000 && !this.checkins.some(c => c.eventId === e.id && c.end === e.end) && day.events.some(next => !next.allDay && next.busy && next.start >= e.end)).at(-1);
      if (!event) return;
      const checkin: Checkin = { id: randomUUID(), eventId: event.id, end: event.end, expiresAt: now + 30 * 60_000, done: false };
      this.checkins.push(checkin); this.store.write('calendar-checkins', this.checkins);
      await this.notify(`Dayflow · Still at “${event.title.slice(0, 140)}”?\nIt was scheduled to finish at ${calendarTime(event.end, day.timezone)}. If you need more time, I’ll check the rest of your day before proposing any changes.`, [[{ text: 'Finished', callback_data: `daydone:${checkin.id}` }], [{ text: 'Need 15 more min', callback_data: `daymore:${checkin.id}:15` }, { text: 'Need 30 more min', callback_data: `daymore:${checkin.id}:30` }]]);
    });
  }
  async action(action: string, id: string, value?: string) {
    if (action === 'dayapprove') return this.approve(id);
    if (action === 'daydismiss') return this.dismiss(id);
    const c = this.checkins.find(c => c.id === id && !c.done && c.expiresAt > this.now());
    if (!c) throw new Error('This check-in expired or was already answered. Open My calendar for a fresh review.');
    if (action === 'daymore') await this.preview(c.eventId, Number(value), 10);
    else if (action !== 'daydone') throw new Error('Unknown Calendar action.');
    c.done = true; this.store.write('calendar-checkins', this.checkins);
  }
}
