import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CalendarEvent, CalendarSnapshot, DayPlan, EventRule, PeerOrigin } from '../shared/calendar.js';
import { calendarRange, calendarTime } from '../shared/calendar.js';
import type { CalendarBridge } from './calendar-bridge.js';
import { Engine, type EngineDependencies } from './engine.js';
import { ReplyInbox } from './inbox.js';
import { Store } from './store.js';
import { nextSlot, negotiationPolicy } from './negotiation.js';
import type { Proposal } from '../shared/types.js';
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
    if (this.state.plan?.status === 'applying') { this.state.plan.status = 'uncertain'; this.state.plan.error = 'DayMade restarted during a calendar save. Check Calendar before creating another plan.'; }
    else if (this.state.plan?.status === 'coordinating' && !this.state.plan.automatic) { this.state.plan.status = 'attention'; this.state.plan.error = 'DayMade restarted while coordinating. Review the recorded replies and messages, then stop this plan and prepare a fresh one. No automatic resend or calendar save will run.'; }
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
    if (this.state.paused && !connect) throw new Error('Calendar is disconnected. Reconnect it in My calendar.');
    if (connect) this.state.paused = false;
    try { const day = await this.bridge.read(connect); this.state.day = day; this.state.connected = true; this.state.error = null; this.state.refreshedAt = this.now(); this.save(); return day; }
    catch (e) { this.state.connected = false; this.state.error = (e as Error).message; this.save(); throw e; }
  }
  get working() { return this.busy; }
  disconnect() {
    if (this.busy) throw new Error('Wait for the current Calendar action to finish, then disconnect.');
    if (this.state.plan && !['applied', 'dismissed', 'unresolved'].includes(this.state.plan.status)) this.dismiss(this.state.plan.id);
    this.checkins = []; this.store.write('calendar-checkins', this.checkins);
    this.state.paused = true; this.state.connected = false; this.state.monitoring = false; this.state.error = null; this.save();
  }
  refresh(connect = false) { return this.exclusive(() => this.read(connect)); }
  configure(monitoring: boolean) { if (this.busy) throw new Error('Wait for the current action.'); if (monitoring && !this.state.connected) throw new Error('Connect Apple Calendar first.'); this.state.monitoring = monitoring; if (!monitoring) { this.checkins = []; this.store.write('calendar-checkins', this.checkins); } this.monitorSince = this.now(); this.save(); }
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
      plan.automatic = true;
      this.state.plan = plan; this.restoreConversations();
      try {
        for (const { engine } of this.conversations) {
          const change = plan.changes.find(c => c.conversation === engine.state)!;
          await engine.prepareCalendar(plan, change);
        }
      } catch (e) { plan.blockers.push((e as Error).message); }
      this.save();
      if (!plan.blockers.length && plan.changes.length) await this.notifyPlan();
      else await this.notify(`DayMade · Calendar review\n${plan.blockers.length ? plan.blockers.join('\n') : 'Your remaining schedule has enough room. No later event needs to move.'}`);
      return plan;
    });
  }
  async reschedule(eventId: string, time: string, expectedDay: string, bufferMinutes = 10, earliestStart?: number) {
    if (this.active || this.legacyActive()) throw new Error('Finish or stop the active conversation before planning another change.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 60) throw new Error('Choose a valid time and transition buffer.');
    return this.exclusive(async () => {
      const day = await this.read();
      if (day.day !== expectedDay) throw new Error('The day changed. Refresh Calendar and select a meeting today.');
      const event = day.events.find(e => e.id === eventId), rule = this.state.rules[eventId];
      if (!event?.editable || event.allDay || !event.busy || event.start <= this.now()) throw new Error('Choose an editable personal event that has not started yet.');
      if (!rule?.flexible) throw new Error('Enable rescheduling for this event and choose its friends first.');
      let start = day.dayEnd;
      for (let at = Math.ceil(day.dayStart / 60000) * 60000; at < day.dayEnd; at += 60000) if (calendarTime(at, day.timezone) === time) { start = at; break; }
      const end = start + event.end - event.start, buffer = bufferMinutes * 60000;
      if (start <= this.now() || end > day.dayEnd) throw new Error('Choose a future time today that leaves room for the full meeting.');
      if (start === event.start) throw new Error('That is already the meeting’s start time. Choose a different time.');
      if (earliestStart !== undefined && (!Number.isFinite(earliestStart) || start < earliestStart)) throw new Error('The proposed time is before your estimated arrival. Refresh travel.');
      const conflicts = day.events.filter(e => e.id !== eventId && e.busy && start < e.end + buffer && end + buffer > e.start);
      const plan: DayPlan = { id: randomUUID(), earliestStart, reschedule: true, automatic: true, day: day.day, timezone: day.timezone, revision: day.revision, source: event, assumedEnd: this.now(), bufferMinutes, changes: [{ event, start, end, personIds: [...rule.personIds] }], blockers: conflicts.map(e => `This time conflicts with “${e.title}” (${e.allDay ? 'all day' : calendarRange(e.start, e.end, day.timezone)}) or its ${bufferMinutes}-minute buffer.`), status: 'draft', createdAt: this.now(), expiresAt: this.now() + 10 * 60000 };
      this.state.plan = plan; this.restoreConversations();
      if (!plan.blockers.length) {
        try { for (const { engine } of this.conversations) await engine.prepareCalendar(plan, plan.changes[0]); }
        catch (e) { plan.blockers.push((e as Error).message); }
      }
      this.save();
      if (!plan.blockers.length) await this.notifyPlan();
      return plan;
    });
  }
  async preparePeerChange(eventId: string, start: number, peer: PeerOrigin, bufferMinutes = 10, expectedEvent?: CalendarEvent) {
    if (this.active || this.legacyActive()) throw new Error('Another conversation is active. This request will wait.');
    return this.exclusive(async () => {
      const day = await this.read(), event = day.events.find(e => e.id === eventId), rule = this.state.rules[eventId];
      if (expectedEvent && (!event || event.start !== expectedEvent.start || event.end !== expectedEvent.end || event.title !== expectedEvent.title || event.calendarId !== expectedEvent.calendarId)) throw new Error('This meeting changed outside DayMade. Ask for a fresh request.');
      if (!event?.editable || event.start <= this.now() || !rule?.flexible || !rule.personIds.includes(peer.requesterId)) throw new Error('This future meeting is no longer enabled for teammate changes.');
      const end = start + event.end - event.start, buffer = bufferMinutes * 60000;
      if (start <= this.now() || start < day.dayStart || end > day.dayEnd) throw new Error('Choose a future time within today.');
      if (day.events.some(e => e.id !== eventId && e.busy && start < e.end + buffer && end + buffer > e.start)) throw new Error('Calendar changed and this slot is now busy.');
      const plan: DayPlan = { id: randomUUID(), peer, automatic: true, day: day.day, timezone: day.timezone, revision: day.revision, source: event, assumedEnd: this.now(), bufferMinutes, changes: [{ event, start, end, personIds: [...rule.personIds] }], blockers: [], status: 'draft', createdAt: this.now(), expiresAt: this.now() + 10 * 60000 };
      this.state.plan = plan; this.restoreConversations();
      try { await this.conversations[0].engine.prepareCalendar(plan, plan.changes[0]); }
      catch (e) { plan.status = 'unresolved'; plan.error = (e as Error).message; this.save(); throw e; }
      this.save(); return plan;
    });
  }
  async notifyPlan() {
    const p = this.state.plan;
    if (!p || p.status !== 'draft' || p.blockers.length || !p.changes.length || p.expiresAt <= this.now()) throw new Error('Build a current, unblocked calendar plan first.');
    const detail = p.changes.map(c => `${c.event.title.slice(0, 140)}: ${calendarRange(c.event.start, c.event.end, p.timezone)} → ${calendarRange(c.start, c.end, p.timezone)}\n${c.conversation?.proposal ? `To: ${c.conversation.proposal.people.map(recipientLabel).join(', ')} in ${c.conversation.proposal.destinationName}\nMessage: ${c.conversation.proposal.text}` : 'Personal event: calendar change only; no messages.'}`).join('\n\n');
    const text = `DayMade · LIVE CALENDAR PLAN · ${p.day} (${p.timezone})\n\n${p.peer ? p.peer.reason : p.reschedule ? "You requested a change to a real Calendar event." : `You expect to finish “${p.source.title.slice(0, 140)}” at ${calendarTime(p.assumedEnd, p.timezone)}.`} Transition buffer: ${p.bufferMinutes} min.\n\n${detail}\n\nApprove coordination and calendar changes? ${p.automatic ? negotiationPolicy : ""} I will save all changes only after every named friend agrees. Fixed events stay in place. Approval expires in 10 minutes.`;
    if (text.length > 4000) return this.notify('DayMade · Your calendar plan is ready. It is too long to review in one Telegram message. Open My calendar on your Mac to review and approve every change.');
    await this.notify(text, [[{ text: p.automatic ? 'Let DayMade coordinate & update Calendar' : 'Approve messages & calendar changes', callback_data: `dayapprove:${p.id}` }], [{ text: 'Dismiss', callback_data: `daydismiss:${p.id}` }]]);
  }
  async approve(id: string) {
    return this.exclusive(async () => {
      const p = this.state.plan;
      if (!p || p.id !== id || p.status !== 'draft' || p.blockers.length || !p.changes.length) throw new Error('This calendar approval is no longer active.');
      if (p.expiresAt <= this.now()) throw new Error('Approval expired. Build a fresh plan.');
      if (this.legacyActive()) throw new Error('Stop the previous conversation first.');
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
      catch (e) { p.status = 'attention'; p.error = (e as Error).message; this.save(); await this.notify(`DayMade · Calendar plan paused\n${p.error}\nCheck the recorded deliveries. No automatic resend or calendar save.`); return; }
      await this.advance();
    });
  }
  dismiss(id: string) {
    if (this.busy) throw new Error('Wait for the current action to finish.');
    const p = this.state.plan; if (!p || p.id !== id || ['applied', 'dismissed'].includes(p.status)) throw new Error('This calendar plan is no longer active.');
    p.status = 'dismissed'; p.error = p.approvedAt ? 'Monitoring stopped. Already sent messages are not retracted. Check the conversations before creating another plan.' : undefined; this.save();
  }
  private async alternative(proposal: Proposal) {
    const p = this.state.plan!;
    const change = p.changes.find(c => c.conversation?.proposal?.id === proposal.id);
    if (!change) throw new Error('This meeting is no longer in the plan.');
    const day = await this.read();
    if (day.day !== p.day) throw new Error('Today has ended.');
    for (const planned of p.changes) {
      const current = day.events.find(e => e.id === planned.event.id);
      if (!current || !current.editable || current.start !== planned.event.start || current.end !== planned.event.end || current.title !== planned.event.title || current.calendarId !== planned.event.calendarId) throw new Error('An event in this plan was edited or removed outside DayMade.');
    }
    const busy = day.events.filter(e => e.busy && (p.peer || p.reschedule || !e.allDay) && e.id !== change.event.id).map(e => {
      const move = p.changes.find(c => c.event.id === e.id);
      return move ? { start: move.start, end: move.end } : { start: e.start, end: e.end };
    });
    const slot = nextSlot(day, proposal, busy, Math.max(p.earliestStart || 0, (p.peer || p.reschedule) ? day.dayStart : change.event.start, p.assumedEnd + p.bufferMinutes * 60000), p.bufferMinutes, this.now());
    if (slot) { change.start = slot.start; change.end = slot.end; p.revision = day.revision; this.save(); }
    return slot;
  }
  private async advance() {
    const p = this.state.plan; if (!p || p.status !== 'coordinating') return;
    if (p.automatic) {
      for (const { engine } of this.conversations) await engine.negotiate(proposal => this.alternative(proposal));
      const ended = this.conversations.find(c => c.engine.state.phase === 'unresolved');
      if (ended) { p.status = 'unresolved'; p.error = ended.engine.state.summary || 'No common time was found.'; this.save(); await this.notify(`DayMade · Coordination finished without agreement\n${p.error}\nCalendar is unchanged.`); return; }
    }
    if (this.conversations.some(c => ['attention', 'uncertain'].includes(c.engine.state.phase))) {
      p.status = 'attention'; p.error = 'A friend suggested another time, declined, or needs clarification. Review the replies, stop this plan, then prepare a fresh plan. Calendar is unchanged.'; this.save(); await this.notify(`DayMade · Calendar plan paused\n${p.error}`); return;
    }
    if (this.now() - p.approvedAt! > 30 * 60_000 || p.changes.some(c => c.start <= this.now())) { p.status = p.automatic ? 'unresolved' : 'attention'; p.error = 'This plan ran out of time while waiting. Review your day again; calendar is unchanged.'; this.save(); await this.notify(`DayMade · ${p.error}`); return; }
    if (!this.conversations.every(c => c.engine.state.phase === 'agreed')) return;
    try {
      const day = await this.read();
      if (day.day !== p.day) throw new Error('Today has ended before everyone could agree.');
      if (day.revision !== p.revision || p.automatic) {
        if (!p.automatic) throw new Error('Your calendar changed while coordinating. Review a fresh plan before saving.');
        for (const change of p.changes) {
          const current = day.events.find(e => e.id === change.event.id);
          if (!current || !current.editable || current.start !== change.event.start || current.end !== change.event.end || current.title !== change.event.title) throw new Error('An event in the plan was edited outside DayMade.');
          const buffer = p.bufferMinutes * 60000;
          const conflict = day.events.some(e => e.id !== change.event.id && (p.peer || p.reschedule || !e.allDay) && e.busy && !p.changes.some(c => c.event.id === e.id) && change.start < e.end + buffer && change.end + buffer > e.start);
          if (conflict && change.conversation?.proposal) {
            const engine = this.conversations.find(c => c.engine.state === change.conversation)!.engine;
            engine.log('Calendar changed', 'A new event conflicts with the agreed slot. Finding another time.');
            await engine.negotiate(async proposal => { const slot = await this.alternative(proposal); return slot ? { ...slot, reason: 'A new Calendar event conflicts with the previous slot. This alternative is free.' } : null; }, true);
            return;
          }
          if (conflict) throw new Error('A new calendar event conflicts with personal time in this plan.');
        }
        p.revision = day.revision; this.save();
      }
    } catch (e) { p.status = p.automatic ? 'unresolved' : 'attention'; p.error = (e as Error).message; this.save(); await this.notify(`DayMade · Calendar not changed\n${p.error}`); return; }
    for (const { inbox } of this.conversations) await inbox.drain();
    if (!this.conversations.every(c => c.engine.state.phase === 'agreed')) return;
    p.status = 'applying'; this.save();
    try { p.receipts = await this.bridge.apply(p); p.status = 'applied'; p.appliedAt = this.now(); this.save(); }
    catch (e) { p.status = 'uncertain'; p.error = `${(e as Error).message} Inspect Apple Calendar before trying again. No automatic retry.`; this.save(); await this.notify(`DayMade · Check Calendar\n${p.error}`); return; }
    await this.notify(`DayMade · Calendar updated\n${p.changes.map(c => `${c.event.title.slice(0, 140)} → ${calendarRange(c.start, c.end, p.timezone)}`).join('\n')}\n${p.timezone}. Changes to iCloud calendars sync to your iPhone.${p.peer || p.reschedule ? '' : ' Your current event’s stored end time was not changed.'}`);
    if (p.peer || p.reschedule) {
      for (const { engine } of this.conversations) {
        const proposal = engine.state.proposal!;
        for (const person of proposal.people) {
          // The applied state is persisted before these one-time confirmations; never replay after restart.
          try { await this.deps.send(person, { ...proposal, text: `Confirmed: “${p.changes[0].event.title.slice(0, 140)}” on ${p.day}, ${calendarRange(p.changes[0].start, p.changes[0].end, p.timezone)} (${p.timezone}). Everyone agreed and the owner’s Calendar has been updated.` }); }
          catch { engine.log('Final confirmation delivery not confirmed', `${person.name}: Calendar is saved, but the final chat message could not be confirmed. No automatic retry.`, 'warning'); await this.notify(`Calendar is saved, but the final confirmation to ${person.name} could not be delivered. Check the recorded conversation.`); }
        }
      }
    }
    const refreshed = await this.read().catch(() => null);
    if (refreshed) for (const change of p.changes) {
      const moved = refreshed.events.find(e => e.eventIdentifier === change.event.eventIdentifier && e.calendarId === change.event.calendarId && e.start === change.start && e.end === change.end);
      if (moved && moved.id !== change.event.id && this.state.rules[change.event.id]) { this.state.rules[moved.id] = this.state.rules[change.event.id]; delete this.state.rules[change.event.id]; }
    }
    this.save();
  }
  async tick() {
    if (this.busy || this.state.paused) return;
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
      await this.notify(`DayMade · Still at “${event.title.slice(0, 140)}”?\nIt was scheduled to finish at ${calendarTime(event.end, day.timezone)}. If you need more time, I’ll check the rest of your day before proposing any changes.`, [[{ text: 'Finished', callback_data: `daydone:${checkin.id}` }], [{ text: 'Need 15 more min', callback_data: `daymore:${checkin.id}:15` }, { text: 'Need 30 more min', callback_data: `daymore:${checkin.id}:30` }]]);
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
