import { randomUUID } from 'node:crypto';
import type { Delivery, Mode, Person, Proposal, State } from '../shared/types.js';
import { SendFailure, recipientLabel, type Receipt } from './transport.js';
import type { Interpretation } from './llm.js';
import { initialState } from './store.js';

export interface EngineDependencies {
  save: (state: State) => void;
  opening: () => Promise<{ text: string; ai: boolean; note?: string }>;
  interpret: (text: string, time: string) => Promise<Interpretation & { ai: boolean }>;
  destination: () => Promise<{ destinationId: string; destinationName: string; people: Pick<Person, 'id' | 'name' | 'platform' | 'address'>[] }>;
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
  private replyQueue: Promise<unknown> = Promise.resolve();
  private now: () => number;
  constructor(private deps: EngineDependencies, saved?: State) {
    this.state = saved || initialState(); this.now = deps.now || Date.now;
    if (this.state.phase === 'sending') {
      this.state.phase = 'uncertain'; this.state.error = 'The app restarted during a send. Check the conversation on its platform before creating a new proposal.';
      for (const person of this.state.proposal?.people || []) if (person.delivery === 'sending') person.delivery = 'uncertain';
    }
    if (this.state.phase === 'preparing') this.state.phase = 'observing';
    this.persist();
  }
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
  async advance() {
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
    await this.prepare('14:00');
  }
  async prepare(time: string) {
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
      const text = `${draft.text} Would moving our 1:30 pm meeting to ${formatTime(time)}–${formatTime(endTime)} HKT work for everyone?\n\nPlease reply with ${code} and your answer (for example, “${code} yes” or “${code} could we do 2:15 pm?”).`;
      this.state.proposal = { id, code, time, endTime, text, createdAt: this.now(), expiresAt: this.now() + 10 * 60_000, destinationId: destination.destinationId, destinationName: destination.destinationName, people: destination.people.map(p => ({ ...p, status: 'pending' as const, delivery: 'not_sent' as const })), ai: draft.ai, aiNote: draft.note, mode: this.state.mode, transport: 'social' };
      this.state.phase = 'approval'; this.state.summary = null; this.state.processedMessages = [];
      this.log('A proposal is ready', `${formatTime(time)}–${formatTime(endTime)}. ${draft.ai ? 'Drafted with the local model.' : 'Template draft; model unavailable.'} Waiting for your approval.`);
      await this.notify(`Dayflow · ${this.state.mode === 'replay' ? 'SCENARIO REPLAY — no coworker message will be sent' : 'LIVE MEETING PROPOSAL'}\n\nYou appear to still be at lunch. Your meeting begins in 15 min, but travel and buffer take 25 min.\n\nPropose ${formatTime(time)}–${formatTime(endTime)} to ${destination.people.map(recipientLabel).join(', ')} in ${destination.destinationName}?\n\n${text}\n\nApproval expires in 10 minutes.`, this.state.proposal);
    } catch (error) { this.state.phase = oldPhase; this.state.error = (error as Error).message; this.persist(); throw error; }
  }
  async approve(id: string) {
    const proposal = this.state.proposal;
    if (!proposal || proposal.id !== id || this.state.phase !== 'approval') throw new Error('This approval is no longer active. Open the latest proposal.');
    if (proposal.expiresAt < this.now()) throw new Error('This approval has expired. Prepare a fresh proposal.');
    // Claim the approval synchronously before any network call; double taps cannot send twice.
    this.state.phase = 'sending'; proposal.approvedAt = this.now(); this.state.error = null; this.persist();
    if (proposal.mode === 'live') {
      try {
        const current = await this.deps.destination();
        const ids = (people: Person[] | Pick<Person, 'id' | 'name' | 'platform' | 'address'>[]) => people.map(p => `${p.id}:${p.name}:${p.platform}:${p.address}`).sort().join(',');
        if (current.destinationId !== proposal.destinationId || ids(current.people) !== ids(proposal.people)) throw new Error('Recipient list or sender changed. Prepare a fresh proposal before sending.');
      } catch (error) { this.state.phase = 'approval'; this.state.error = (error as Error).message; this.persist(); throw error; }
    }
    this.log('You approved the proposal', `${formatTime(proposal.time)} to ${proposal.destinationName}.`);
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
        await this.notify(`Dayflow · Coordination\n${this.state.error}`);
        throw error;
      }
    }
    this.state.phase = 'waiting';
    this.log(proposal.mode === 'live' ? 'Proposals sent to your coworkers' : 'Proposal sent in replay', `${proposal.people.length} individual messages. Waiting for ${proposal.people.map(p => p.name).join(' and ')}.`, 'success');
    await this.notify(`Dayflow · ${proposal.mode === 'replay' ? 'Replay' : 'Coordination'}\n${proposal.mode === 'live' ? 'The platforms accepted the individual messages' : 'Replay proposal sent'} for ${formatTime(proposal.time)}. I’ll report responses here. No calendar event has been changed.`);
  }
  dismiss(id: string) {
    if (this.state.phase !== 'approval' || this.state.proposal?.id !== id) throw new Error('This proposal is no longer awaiting approval.');
    this.state.phase = 'dismissed'; this.log('Proposal dismissed', 'No coworker message was sent.');
  }
  reply(proposalId: string, personId: string, text: string, messageId: string) {
    const task = this.replyQueue.then(() => this.recordReply(proposalId, personId, text, messageId));
    this.replyQueue = task.catch(() => {}); return task;
  }
  private async recordReply(proposalId: string, personId: string, text: string, messageId: string) {
    const proposal = this.state.proposal;
    if (!proposal || proposal.id !== proposalId || !['waiting', 'attention', 'agreed', 'uncertain'].includes(this.state.phase)) return;
    if (this.state.processedMessages.includes(messageId)) return;
    const person = proposal.people.find(p => p.id === personId);
    if (!person || !text.trim()) return;
    const interpretation = await this.deps.interpret(text, proposal.time);
    if (this.state.proposal?.id !== proposalId || !['waiting', 'attention', 'agreed', 'uncertain'].includes(this.state.phase)) return;
    this.state.processedMessages.push(messageId);
    person.status = interpretation.status; person.text = text; person.proposedTime = interpretation.proposedTime || undefined;
    if (['queued', 'sent', 'uncertain', 'failed'].includes(person.delivery || '')) { person.delivery = 'delivered'; person.deliveryError = undefined; }
    this.log(`${person.name} replied`, `${text} · ${interpretation.ai ? 'Local model interpretation' : 'Conservative rules interpretation'}.`);
    const accepted = proposal.people.filter(p => p.status === 'accepted').length;
    if (accepted === proposal.people.length) {
      this.state.phase = 'agreed'; this.state.summary = `Everyone agreed to ${formatTime(proposal.time)}. The calendar invite has not been changed.`;
      this.log('Everyone is on the same page', this.state.summary, 'success');
    } else if (proposal.people.some(p => ['failed', 'uncertain', 'not_sent'].includes(p.delivery || ''))) {
      this.state.phase = proposal.people.some(p => p.delivery === 'uncertain') ? 'uncertain' : 'attention';
      this.state.summary = `${accepted} of ${proposal.people.length} accepted. Some messages were not delivered or delivery is unconfirmed; check each recipient’s status.`;
    } else if (proposal.people.some(p => ['counterproposal', 'declined', 'unclear'].includes(p.status))) {
      this.state.phase = 'attention'; this.state.summary = `${accepted} of ${proposal.people.length} accepted. A reply needs your attention; any different time needs your approval.`;
    } else { this.state.phase = 'waiting'; this.state.summary = `${accepted} of ${proposal.people.length} accepted. Waiting for the remaining responses.`; }
    this.persist();
    await this.notify(`Dayflow · ${proposal.mode === 'replay' ? 'Replay' : 'Coordination'}\n${person.name}: “${text}”\n\n${this.state.summary}${interpretation.proposedTime ? `\nSuggested time: ${formatTime(interpretation.proposedTime)}. Open Dayflow to prepare a new proposal.` : ''}`);
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
      await this.notify(`Dayflow · Coordination\n${this.state.error}\nNo automatic resend was made.`);
    } else { person.deliveryError = undefined; this.persist(); }
  }
}
