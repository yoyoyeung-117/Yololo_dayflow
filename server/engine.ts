import { randomUUID } from 'node:crypto';
import type { Delivery, Mode, Person, Proposal, State } from '../shared/types.js';
import { SendFailure, recipientLabel, type Receipt } from './transport.js';
import type { Interpretation } from './llm.js';
import { calendarTime, calendarRange, type CalendarChange, type DayPlan } from '../shared/calendar.js';
import { negotiationPolicy, type NegotiatedSlot } from './negotiation.js';
import { initialState } from './store.js';

export interface EngineDependencies {
  save: (state: State) => void;
  opening: () => Promise<{ text: string; ai: boolean; note?: string }>;
  interpret: (text: string, time: string) => Promise<Interpretation & { ai: boolean }>;
  destination: (personIds?: string[]) => Promise<{ destinationId: string; destinationName: string; people: Pick<Person, 'id' | 'name' | 'platform' | 'address'>[] }>;
  send: (person: Person, proposal: Proposal) => Promise<Receipt>;
  notify: (text: string, proposal?: Proposal) => Promise<void>;
  now?: () => number;
}

export function lateness(samples: { at: number; latitude: number; longitude: number; accuracy: number }[], now: number, lunchEnd: number, meetingStart: number, travelMinutes = 20, bufferMinutes = 5) {
  const fresh = samples.filter(s => s.at <= now && s.accuracy <= 60 && now - s.at <= 16 * 60_000);
  if (fresh.length < 2) return { risk: false, reason: 'Not enough recent location evidence.' };
  fresh.sort((a, b) => a.at - b.at);
  const first = fresh[0], last = fresh.at(-1)!;
  if (now - last.at > 2 * 60_000 || last.at - first.at < 14 * 60_000) return { risk: false, reason: 'Location evidence is stale or covers too little time.' };
  const maxMovement = Math.max(...fresh.map(s => Math.hypot((s.latitude - first.latitude) * 111_320, (s.longitude - first.longitude) * 111_320 * Math.cos(first.latitude * Math.PI / 180))));
  const lateMinutes = Math.ceil((now + (travelMinutes + bufferMinutes) * 60_000 - meetingStart) / 60_000);
  return { risk: now >= lunchEnd && now < meetingStart && maxMovement < 100 && lateMinutes > 0, lateMinutes, reason: 'Still near lunch, with less time remaining than travel plus buffer.' };
}

export function formatTime(time: string) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

export class Engine {
  state: State;
  private negotiating = false;
  private replyQueue: Promise<unknown> = Promise.resolve();
  private now: () => number;
  constructor(private deps: EngineDependencies, saved?: State) {
    this.state = saved || initialState(); this.now = deps.now || Date.now;
    if (this.state.phase === 'sending') {
      this.state.phase = 'uncertain'; this.state.error = 'The app restarted during a send. Check the conversation on its platform before creating a new proposal.';
      for (const person of this.state.proposal?.people || []) if (person.delivery === 'sending') person.delivery = 'uncertain';
    }
    if (this.state.phase === 'preparing') this.state.phase = this.state.proposal?.negotiation && this.state.proposal.approvedAt ? 'attention' : 'observing';
    this.persist();
  }
  get working() { return this.negotiating || ['preparing', 'sending'].includes(this.state.phase); }
  private persist() { this.state.version++; this.deps.save(this.state); }
  log(title: string, detail: string, kind: 'info' | 'success' | 'warning' = 'info') {
    this.state.activity.unshift({ id: randomUUID(), at: this.now(), title, detail, kind });
    this.state.activity = this.state.activity.slice(0, 60); this.persist();
  }
  private async notify(text: string, proposal?: Proposal) {
    try { await this.deps.notify(text, proposal); this.state.telegramNotificationError = null; }
    catch { this.state.telegramNotificationError = 'Telegram delivery failed. Your current action and responses are available here.'; }
    this.persist();
  }
  reset(mode: Mode = this.state.mode) {
    if (['preparing', 'sending'].includes(this.state.phase)) throw new Error('Wait for the current action to finish.');
    if (this.state.mode === 'live' && ['waiting', 'attention', 'uncertain'].includes(this.state.phase)) throw new Error('Finish monitoring this live proposal before resetting.');
    this.state = initialState(); this.state.mode = mode;
    this.log('Your day is being watched', 'Scenario replay is ready. Calendar and location are demo inputs.');
  }
  finishMonitoring() {
    if (!['waiting', 'attention', 'uncertain', 'agreed'].includes(this.state.phase)) throw new Error('There is no active conversation to finish.');
    this.state.phase = 'dismissed'; this.state.summary = 'Monitoring stopped by you. This does not cancel or change the meeting proposal.';
    this.log('Monitoring stopped', this.state.summary, 'warning');
  }
  async advance(automatic = false) {
    if (this.state.phase !== 'observing') throw new Error('Reset the scenario before running it again.');
    const now = this.now();
    const risk = lateness([
      { at: now - 15 * 60_000, latitude: 22.283, longitude: 114.155, accuracy: 12 },
      { at: now - 7 * 60_000, latitude: 22.28301, longitude: 114.15502, accuracy: 14 },
      { at: now, latitude: 22.28302, longitude: 114.15501, accuracy: 10 },
    ], now, now - 15 * 60_000, now + 15 * 60_000);
    if (!risk.risk) throw new Error('No delay detected.');
    this.state.clock = '13:15';
    this.log('A likely delay, spotted', 'Replayed samples: 15 minutes at lunch. Travel 20 min + buffer 5 min; meeting in 15 min. Estimated arrival 1:40 pm.', 'warning');
    await this.prepare('14:00', automatic);
  }
  async prepare(time: string, automatic = false) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || time < '13:40' || time > '22:30') throw new Error('Choose a time between 1:40 pm and 10:30 pm.');
    if (!['observing', 'approval', 'attention', 'agreed', 'waiting'].includes(this.state.phase)) throw new Error('A proposal cannot be prepared right now.');
    const oldPhase = this.state.phase;
    this.state.phase = 'preparing'; this.state.error = null; this.persist();
    try {
      const destination = this.state.mode === 'live' ? await this.deps.destination() : { destinationId: '', destinationName: 'Discord + Zoom · demo', people: [{ id: 'alex', name: 'Alex Chen', platform: 'discord' as const }, { id: 'sam', name: 'Sam Wong', platform: 'zoom' as const }] };
      if (!destination.people.length) throw new Error('Add at least one coworker in Connections.');
      const draft = await this.deps.opening();
      const id = randomUUID(), code = `#DF-${id.slice(0, 6).toUpperCase()}`;
      const [hours, minutes] = time.split(':').map(Number), end = hours * 60 + minutes + 30;
      const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
      const text = `${draft.text} Would moving our 1:30 pm meeting to ${formatTime(time)}–${formatTime(endTime)} HKT work for everyone?\n\nUse Reply on this message and type your answer (for example, “yes” or “could we do 2:15 pm?”). On Discord, no @bot mention is needed; you can turn the reply ping off. Or include ${code} in a new message.`;
      this.state.proposal = { id, code, time, endTime, text, createdAt: this.now(), expiresAt: this.now() + 10 * 60_000, destinationId: destination.destinationId, destinationName: destination.destinationName, people: destination.people.map(p => ({ ...p, status: 'pending' as const, delivery: 'not_sent' as const })), ai: draft.ai, aiNote: draft.note, mode: this.state.mode, transport: 'social', ...(automatic ? { negotiation: { round: 1, maxRounds: 6, deadline: 0, earliestTime: time, history: [] } } : {}) };
      this.state.phase = 'approval'; this.state.summary = null; this.state.processedMessages = [];
      this.log('A proposal is ready', `${formatTime(time)}–${formatTime(endTime)}. ${draft.ai ? 'Drafted with the local model.' : 'Template draft; model unavailable.'} Waiting for your approval.`);
      await this.notify(`DayMade · ${this.state.mode === 'replay' ? 'SCENARIO REPLAY — no coworker message will be sent' : 'LIVE MEETING PROPOSAL'}\n\nYou appear to still be at lunch. Your meeting begins in 15 min, but travel and buffer take 25 min.\n\nPropose ${formatTime(time)}–${formatTime(endTime)} to ${destination.people.map(recipientLabel).join(', ')} in ${destination.destinationName}?\n\n${text}\n\n${automatic ? negotiationPolicy + "\n\n" : ""}Approval expires in 10 minutes.`, this.state.proposal);
    } catch (error) { this.state.phase = oldPhase; this.state.error = (error as Error).message; this.persist(); throw error; }
  }
  async prepareCalendar(plan: DayPlan, change: CalendarChange) {
    if (this.state.phase !== 'observing') throw new Error('This calendar conversation has already been prepared.');
    const destination = await this.deps.destination(change.personIds);
    const id = randomUUID(), code = `#DF-${id.slice(0, 6).toUpperCase()}`;
    const time = calendarTime(change.start, plan.timezone), endTime = calendarTime(change.end, plan.timezone);
    const text = `${plan.peer ? plan.peer.reason : plan.reschedule ? "I’d like to reschedule our meeting." : "I’m running behind."} Could we move “${change.event.title.slice(0, 140)}” on ${plan.day} from ${calendarRange(change.event.start, change.event.end, plan.timezone)} to ${calendarRange(change.start, change.end, plan.timezone)} (${plan.timezone})?\n\nPlease reply with ${code} and your answer, for example “${code} yes”. If this does not work, suggest another time today and I’ll check it against the calendar.`;
    this.state.mode = 'live'; this.state.phase = 'approval';
    this.state.proposal = { id, code, time, endTime, text, calendarPlanId: plan.id, ...(plan.peer && plan.peer.requestedTime === time ? { requesterConsent: { personId: plan.peer.requesterId, time, text: plan.peer.originalText, sourceMessageId: plan.peer.sourceMessageId } } : {}), meetingTitle: change.event.title, meetingDay: plan.day, timezone: plan.timezone, ...(plan.automatic ? { negotiation: { round: 1, maxRounds: 6, deadline: 0, earliestTime: time, history: [] } } : {}), createdAt: this.now(), expiresAt: plan.expiresAt, destinationId: destination.destinationId, destinationName: destination.destinationName, people: destination.people.map(p => ({ ...p, status: 'pending', delivery: 'not_sent' })), ai: false, mode: 'live', transport: 'social' };
    this.persist();
  }
  async approve(id: string, automatic = false) {
    const proposal = this.state.proposal;
    if (!proposal || proposal.id !== id || this.state.phase !== 'approval') throw new Error('This approval is no longer active. Open the latest proposal.');
    if (proposal.expiresAt < this.now()) throw new Error('This approval has expired. Prepare a fresh proposal.');
    // Claim the approval synchronously before any network call; double taps cannot send twice.
    this.state.phase = 'sending'; proposal.approvedAt = this.now(); this.state.error = null; this.persist();
    if (proposal.mode === 'live') {
      try {
        const current = await this.deps.destination(proposal.calendarPlanId ? proposal.people.map(p => p.id) : undefined);
        const ids = (people: Person[] | Pick<Person, 'id' | 'name' | 'platform' | 'address'>[]) => people.map(p => `${p.id}:${p.name}:${p.platform}:${p.address}`).sort().join(',');
        if (current.destinationId !== proposal.destinationId || ids(current.people) !== ids(proposal.people)) throw new Error('Recipient list or sender changed. Prepare a fresh proposal before sending.');
      } catch (error) { this.state.phase = 'approval'; this.state.error = (error as Error).message; this.persist(); throw error; }
    }
    if (proposal.negotiation && !proposal.negotiation.deadline) proposal.negotiation.deadline = this.now() + 30 * 60_000;
    this.log(automatic ? 'Agent proposed the next available time' : 'You approved the proposal', `${formatTime(proposal.time)} to ${proposal.destinationName}.`);
    proposal.sentAt = this.now();
    for (const person of proposal.people) {
      person.delivery = 'sending'; this.persist();
      try {
        const message: Receipt = proposal.mode === 'live' ? await this.deps.send(person, proposal) : { id: `replay-${randomUUID()}`, createdDateTime: new Date(this.now()).toISOString() };
        person.messageId = message.id; person.delivery = proposal.mode === 'live' ? (message.delivery || 'sent') : 'delivered';
        proposal.messageId ||= message.id; this.persist();
      } catch (error) {
        // Preserve every successful recipient receipt. Never resend the entire batch after a partial send.
        person.delivery = error instanceof SendFailure && error.definitive ? 'failed' : 'uncertain';
        person.deliveryError = error instanceof Error ? error.message : 'Delivery could not be confirmed.';
        this.state.phase = person.delivery === 'failed' ? 'attention' : 'uncertain';
        this.state.error = `${person.name}: ${person.deliveryError} Remaining messages were not attempted. Check the conversation on its platform before creating another proposal.`;
        this.log('Check message delivery', this.state.error, 'warning');
        await this.notify(`DayMade · Coordination\n${this.state.error}`);
        throw error;
      }
    }
    this.state.phase = 'waiting';
    this.log(proposal.mode === 'live' ? 'Proposals sent to your coworkers' : 'Proposal sent in replay', `${proposal.people.length} individual messages. Waiting for ${proposal.people.map(p => p.name).join(' and ')}.`, 'success');
    const consent = proposal.requesterConsent;
    if (consent && consent.time === proposal.time && (proposal.negotiation?.round || 1) === 1) {
      // The known initiator explicitly requested this exact time; the owner has now approved it.
      await this.recordReply(proposal.id, consent.personId, consent.text, `request:${consent.sourceMessageId}`, { status: 'accepted', proposedTime: null, ai: false });
    }
    if (!automatic) await this.notify(`DayMade · ${proposal.mode === 'replay' ? 'Replay' : 'Coordination'}\n${proposal.mode === 'live' ? 'The platforms accepted the individual messages' : 'Replay proposal sent'} for ${formatTime(proposal.time)}. I’ll report responses here. No calendar event has been changed.`);
  }
  dismiss(id: string) {
    if (this.state.phase !== 'approval' || this.state.proposal?.id !== id) throw new Error('This proposal is no longer awaiting approval.');
    this.state.phase = 'dismissed'; this.log('Proposal dismissed', 'No coworker message was sent.');
  }
  reply(proposalId: string, personId: string, text: string, messageId: string) {
    const task = this.replyQueue.then(() => this.recordReply(proposalId, personId, text, messageId));
    this.replyQueue = task.catch(() => {}); return task;
  }
  private async recordReply(proposalId: string, personId: string, text: string, messageId: string, consent?: Interpretation & { ai: boolean }) {
    const proposal = this.state.proposal;
    if (!proposal || proposal.id !== proposalId || !['waiting', 'attention', 'agreed', 'uncertain'].includes(this.state.phase)) return;
    if (this.state.processedMessages.includes(messageId)) return;
    const person = proposal.people.find(p => p.id === personId);
    if (!person || !text.trim()) return;
    const interpretation = consent || await this.deps.interpret(text, proposal.time);
    if (this.state.proposal?.id !== proposalId || !['waiting', 'attention', 'agreed', 'uncertain'].includes(this.state.phase)) return;
    this.state.processedMessages.push(messageId);
    person.status = interpretation.status; person.text = text; person.proposedTime = interpretation.proposedTime || undefined;
    if (['queued', 'sent', 'uncertain', 'failed'].includes(person.delivery || '')) { person.delivery = 'delivered'; person.deliveryError = undefined; }
    this.log(`${person.name} replied`, `${text} · ${consent ? 'The requester explicitly proposed this time' : interpretation.ai ? 'Local model interpretation' : 'Conservative rules interpretation'}.`);
    const accepted = proposal.people.filter(p => p.status === 'accepted').length;
    if (accepted === proposal.people.length) {
      this.state.phase = 'agreed'; this.state.summary = `Everyone agreed to ${formatTime(proposal.time)}. The calendar invite has not been changed.`;
      this.log('Everyone is on the same page', this.state.summary, 'success');
    } else if (proposal.people.some(p => ['failed', 'uncertain', 'not_sent'].includes(p.delivery || ''))) {
      this.state.phase = proposal.people.some(p => p.delivery === 'uncertain') ? 'uncertain' : 'attention';
      this.state.summary = `${accepted} of ${proposal.people.length} accepted. Some messages were not delivered or delivery is unconfirmed; check each recipient’s status.`;
    } else if (proposal.people.some(p => ['counterproposal', 'declined', 'unclear'].includes(p.status))) {
      this.state.phase = 'attention'; this.state.summary = proposal.negotiation ? `${accepted} of ${proposal.people.length} accepted. I’m checking the calendar or asking a friend to clarify; you don’t need to choose a new time.` : `${accepted} of ${proposal.people.length} accepted. A reply needs your attention; any different time needs your approval.`;
    } else { this.state.phase = 'waiting'; this.state.summary = `${accepted} of ${proposal.people.length} accepted. Waiting for the remaining responses.`; }
    this.persist();
    if (!proposal.negotiation || (this.state.phase === 'agreed' && !proposal.calendarPlanId)) await this.notify(`DayMade · ${proposal.mode === 'replay' ? 'Replay' : 'Coordination'}\n${person.name}: “${text}”\n\n${this.state.summary}${interpretation.proposedTime ? `\nSuggested time: ${formatTime(interpretation.proposedTime)}. ${proposal.negotiation ? 'I’ll check Calendar and coordinate this.' : 'Open DayMade to prepare a new proposal.'}` : ''}`);
  }
  async unresolved(reason: string) {
    this.state.phase = 'unresolved'; this.state.error = null; this.state.summary = reason;
    this.log('Coordination finished without agreement', reason, 'warning');
    if (!this.state.proposal?.calendarPlanId) await this.notify(`DayMade · Could not agree a time\n${reason}\nCalendar is unchanged.`);
  }
  async negotiate(select: (proposal: Proposal) => Promise<NegotiatedSlot | null>, force = false) {
    if (this.negotiating) return;
    const initial = this.state.proposal;
    if (initial?.negotiation?.history.length && initial.negotiation.deadline && this.state.phase === 'approval' && !initial.approvedAt) {
      this.negotiating = true;
      try { await this.approve(initial.id, true); }
      catch (e) { if (this.state.phase === 'approval') await this.unresolved(`Could not resume the delegated proposal: ${(e as Error).message}`); }
      finally { this.negotiating = false; }
      return;
    }
    if (!initial?.negotiation || !initial.approvedAt || !['waiting', 'attention', ...(force ? ['agreed'] : [])].includes(this.state.phase)) return;
    if (initial.people.some(p => ['failed', 'uncertain', 'not_sent', 'sending'].includes(p.delivery || ''))) return;
    this.negotiating = true;
    try {
      await this.replyQueue;
      const proposal = this.state.proposal;
      if (proposal !== initial || !['waiting', 'attention', ...(force ? ['agreed'] : [])].includes(this.state.phase)) return;
      const grant = proposal.negotiation!;
      if (this.now() >= grant.deadline) return this.unresolved('No agreement within the 30-minute coordination window.');
      if (!force && !proposal.people.some(p => ['declined', 'counterproposal'].includes(p.status))) {
        if (proposal.people.some(p => p.status === 'unclear')) { this.state.phase = 'waiting'; this.persist(); }
        for (const person of proposal.people.filter(p => p.status === 'unclear')) {
          if (person.clarificationFor === person.text) continue;
          if (proposal.mode === 'live') {
            try {
              const current = await this.deps.destination(proposal.people.map(p => p.id));
              const key = (people: Pick<Person, 'id' | 'name' | 'platform' | 'address'>[]) => JSON.stringify(people.map(p => [p.id, p.name, p.platform, p.address]).sort());
              if (current.destinationId !== proposal.destinationId || key(current.people) !== key(proposal.people)) throw new Error('The sender or recipients changed.');
            } catch (e) { return this.unresolved(`Could not safely ask for clarification: ${(e as Error).message}`); }
          }

          if ((person.clarificationCount || 0) >= 2) return this.unresolved(`${person.name} could not confirm a time after two clarification requests.`);
          person.clarificationFor = person.text; person.clarificationCount = (person.clarificationCount || 0) + 1;
          this.state.phase = 'sending'; this.persist();
          try {
            const text = `Just checking: can you make ${formatTime(proposal.time)}–${formatTime(proposal.endTime)}${proposal.meetingDay ? ` on ${proposal.meetingDay}` : ''} (${proposal.timezone || 'HKT'})? Please reply yes/no, or suggest a specific time today, for example “how about 15:00?”. Reply to this message or include ${proposal.code}.`;
            const receipt = proposal.mode === 'live' ? await this.deps.send(person, { ...proposal, text }) : { id: `replay-clarify-${randomUUID()}` };
            (person.replyMessageIds ||= []).push(receipt.id);
            this.state.phase = 'waiting'; this.state.summary = `I asked ${person.name} to clarify directly. Waiting for a clear answer.`;
            this.log('Asked a friend to clarify', this.state.summary);
          } catch (e) { this.state.phase = 'uncertain'; this.state.error = `Clarification delivery could not be confirmed: ${(e as Error).message}. Check the conversation; no automatic resend.`; this.persist(); await this.notify(this.state.error); return; }
        }
        return;
      }
      if (grant.round >= grant.maxRounds) return this.unresolved('No common time was agreed after six proposals.');
      this.state.phase = 'preparing'; this.persist();
      let slot: NegotiatedSlot | null;
      try { slot = await select(proposal); }
      catch (e) { return this.unresolved(`I could not verify an available time: ${(e as Error).message}`); }
      if (this.state.proposal !== proposal) return;
      if (!slot) return this.unresolved('There are no more suitable, untried slots in today’s calendar.');
      if (this.now() >= grant.deadline) return this.unresolved('The coordination window ended while checking Calendar.');
      const id = randomUUID(), code = `#DF-${id.slice(0, 6).toUpperCase()}`;
      const history = [...grant.history, { id: proposal.id, code: proposal.code, time: proposal.time, endTime: proposal.endTime, people: structuredClone(proposal.people), reason: slot.reason }];
      const text = `Let’s try another time${proposal.meetingTitle ? ` for “${proposal.meetingTitle.slice(0, 140)}”` : ''}: ${slot.day}, ${formatTime(slot.time)}–${formatTime(slot.endTime)} (${slot.timezone}). I checked the calendar and this slot is free. This replaces the previous proposal; everyone needs to confirm this new time.\n\nUse Reply to answer yes/no or suggest another time today. No @bot mention is needed. Or include ${code} in a new message.`;
      this.state.proposal = { ...proposal, id, code, text, ai: false, aiNote: 'Calendar checked · verified times and recipients', time: slot.time, endTime: slot.endTime, meetingDay: slot.day, timezone: slot.timezone, negotiation: { ...grant, round: grant.round + 1, history }, createdAt: this.now(), expiresAt: Math.min(grant.deadline, this.now() + 10 * 60_000), approvedAt: undefined, sentAt: undefined, messageId: undefined, people: proposal.people.map(p => ({ id: p.id, name: p.name, platform: p.platform, address: p.address, status: 'pending', delivery: 'not_sent' })) };
      this.state.phase = 'approval'; this.state.error = null; this.state.summary = slot.reason; this.state.processedMessages = []; this.persist();
      this.log('Calendar checked for another time', `${slot.reason} Round ${grant.round + 1}: ${slot.time}.`);
      try { await this.approve(id, true); }
      catch (e) { if (this.state.phase === 'approval') await this.unresolved(`Coordination stopped because the destination changed or is unavailable: ${(e as Error).message}`); }
    } finally { this.negotiating = false; }
  }
  async deliveryStatus(messageId: string, status: string, errorCode?: string) {
    const p = this.state.proposal;
    if (!p || p.mode !== 'live' || !['sending', 'waiting', 'attention', 'uncertain', 'agreed'].includes(this.state.phase)) return;
    const person = p.people.find(person => person.messageId === messageId);
    if (!person) return;
    const delivery: Delivery | undefined = ({ accepted: 'queued', queued: 'queued', sending: 'queued', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed' } as Record<string, Delivery>)[status];
    if (!delivery || person.delivery === delivery) return;
    const rank: Record<string, number> = { not_sent: 0, sending: 1, queued: 2, sent: 3, failed: 4, uncertain: 4, delivered: 5, read: 6 };
    if (rank[delivery] < rank[person.delivery || 'not_sent']) return;
    person.delivery = delivery;
    if (delivery === 'failed') {
      person.deliveryError = `The platform reported a delivery error${errorCode ? ` (${errorCode})` : ''}. Check the conversation before sending again.`;
      this.state.phase = 'attention'; this.state.error = `${person.name}: ${person.deliveryError}`;
      this.log('Message delivery failed', this.state.error, 'warning');
      await this.notify(`DayMade · Coordination\n${this.state.error}\nNo automatic resend was made.`);
    } else { person.deliveryError = undefined; this.persist(); }
  }
}
