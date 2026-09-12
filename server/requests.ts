import { randomUUID } from 'node:crypto';
import type { CalendarDay, CalendarEvent, EventRule } from '../shared/calendar.js';
import { calendarRange, calendarTime } from '../shared/calendar.js';
import type { Coworker } from '../shared/types.js';
import type { RequestSnapshot, TeammateRequest } from '../shared/requests.js';
import type { CalendarAgent } from './calendar.js';
import type { Incoming } from './transport.js';
import { mentionedTimes } from './llm.js';
import type { Store } from './store.js';

type Button = { text: string; callback_data: string };
export function requestIntent(text: string, events: CalendarEvent[], rules: Record<string, EventRule>, senderId: string, timezone: string, now: number) {
  if (!/\b(move|change|reschedule|postpone|shift|bring forward|how about|what about|can we|could we)\b|\d{1,2}:\d{2}\s*(ok|okay|instead)\??/i.test(text)) return null;
  if (/\b(no|not|never|don’t|don't|cannot|can’t|can't|won’t|won't|ignore|instructions?|system|tomorrow|yesterday|next|if|maybe|unless|UTC|GMT|PST|EST|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{1,4}[/-]\d{1,2}\b|#DF-/i.test(text)) return null;
  const times = mentionedTimes(text);
  if (!times.length || times.length > 2 || /\b(?:2[4-9]|[3-9]\d):\d{2}\b|\b\d{1,2}:[6-9]\d\b/.test(text)) return null;
  const eligible = events.filter(e => e.editable && !e.allDay && e.busy && e.start > now && rules[e.id]?.flexible && rules[e.id].personIds.includes(senderId));
  const titled = eligible.filter(e => e.title.length >= 3 && text.toLowerCase().includes(e.title.toLowerCase()));
  const sourceMatches = times.length === 2 ? eligible.filter(e => calendarTime(e.start, timezone) === times[0]) : [];
  const candidates = titled.length ? titled.filter(e => times.length !== 2 || sourceMatches.includes(e)) : times.length === 2 ? sourceMatches : eligible;
  if (candidates.length !== 1) return { ambiguous: true as const };
  const event = candidates[0], time = times.at(-1)!;
  if (time === calendarTime(event.start, timezone)) return null;
  return { ambiguous: false as const, event, time };
}
export function requestSlot(day: CalendarDay, event: CalendarEvent, time: string, now: number, bufferMinutes = 10) {
  let requested: number | undefined;
  for (let at = Math.ceil(day.dayStart / 60000) * 60000; at < day.dayEnd; at += 60000) if (calendarTime(at, day.timezone) === time) { requested = at; break; }
  if (requested === undefined || requested <= now) throw new Error('The requested time is not a future time today.');
  const duration = event.end - event.start, buffer = bufferMinutes * 60000;
  const free = (start: number) => start > now && start + duration <= day.dayEnd && day.events.every(e => e.id === event.id || !e.busy || start >= e.end + buffer || start + duration + buffer <= e.start);
  if (free(requested)) return { start: requested, busy: false };
  for (let at = Math.ceil((requested + 60000) / 300000) * 300000; at + duration <= day.dayEnd; at += 300000) if (free(at)) return { start: at, busy: true };
  return { start: null, busy: true };
}

export class TeammateRequests {
  state: RequestSnapshot;
  private busy = false;
  constructor(private store: Store, private calendar: CalendarAgent, private people: () => Coworker[], private occupied: () => boolean,
    private owner: (text: string, buttons?: Button[][]) => Promise<unknown>, private send: (person: Coworker, text: string) => Promise<unknown>, private now = Date.now, private context: () => string = () => '') {
    this.state = store.read('teammate-requests', { enabled: true, since: now(), requests: [], error: null });
    for (const request of this.state.requests) if (request.status === 'reviewing') { request.status = 'unresolved'; request.note = 'Processing was interrupted by a restart. Ask your teammate to send a fresh request.'; }
    this.save();
  }
  get working() { return this.busy; }
  private save() { this.store.write('teammate-requests', this.state); }
  configure(enabled: boolean) {
    if (this.busy) throw new Error('Wait for the current teammate request to finish.');
    this.state.enabled = enabled;
    if (enabled) this.state.since = this.now();
    else for (const r of this.state.requests) if (['queued', 'awaiting_owner'].includes(r.status)) { r.status = 'paused'; r.note = 'Request monitoring was disconnected. Send a new request after reconnecting.'; }
    this.save();
  }
  private currentSender(r: TeammateRequest) { return this.people().find(p => p.enabled && p.id === r.sender.id && p.platform === r.sender.platform && p.address.toLowerCase() === r.sender.address.toLowerCase()); }
  async receive(incoming: Incoming) {
    if (!this.state.enabled || incoming.at < this.state.since || incoming.at > this.now() + 60000 || !Number.isFinite(incoming.at) || /#DF-/i.test(incoming.text)) return;
    const sender = this.people().find(p => p.enabled && p.platform === incoming.platform && p.address.toLowerCase() === incoming.sender.toLowerCase());
    if (!sender || !/\b(move|change|reschedule|postpone|shift|bring forward|how about|what about|can we|could we)\b|\d{1,2}:\d{2}\s*(ok|okay|instead)/i.test(incoming.text)) return;
    const key = `${incoming.platform}:${incoming.messageId}`;
    if (this.state.requests.some(r => r.incomingId === key)) return;
    this.state.requests = this.state.requests.filter(r => r.createdAt >= this.now() - 86400000 || ['queued', 'reviewing', 'awaiting_owner', 'coordinating'].includes(r.status));
    if (this.state.requests.length >= 1000) throw new Error('The teammate request inbox is full. Pause requests and review the inbox.');
    this.state.requests.unshift({ id: randomUUID(), incomingId: key, sender: { ...sender }, text: incoming.text.slice(0, 2000), createdAt: incoming.at, expiresAt: incoming.at + 30 * 60000, status: 'queued', destinationSignature: this.context() }); this.save();
  }
  private async notify(r: TeammateRequest, text: string, buttons?: Button[][]) {
    try { await this.owner(text, buttons); r.notificationError = undefined; } catch { r.notificationError = 'Could not deliver the Telegram card. This request is available in My calendar.'; } this.save();
  }
  private async refresh() { await this.calendar.refresh(); return this.calendar.state.day!; }
  async tick() {
    if (this.busy || !this.state.enabled) return;
    this.busy = true;
    try {
      for (const r of this.state.requests) {
        if (r.status === 'coordinating') {
          const plan = this.calendar.state.plan;
          if (plan && plan.id === r.planId) {
            if (plan.status === 'applied') { r.status = 'completed'; r.selectedTime = calendarTime(plan.changes[0].start, plan.timezone); r.note = 'Everyone agreed. Calendar updated.'; }
            else if (['unresolved', 'dismissed', 'attention', 'uncertain'].includes(plan.status)) { r.status = 'unresolved'; r.note = plan.error || 'Coordination stopped without a confirmed calendar change.'; }
            else if (plan.status === 'draft') { r.status = 'unresolved'; r.note = 'Coordination was interrupted before sending. No automatic retry.'; }
          }
        }
        if (['queued', 'awaiting_owner'].includes(r.status) && r.expiresAt <= this.now()) { r.status = 'expired'; r.note = 'This request expired without a response.'; }
      }
      this.save();
      if (this.occupied() || this.calendar.active || this.calendar.state.plan?.status === 'draft' || this.state.requests.some(r => r.status === 'awaiting_owner')) return;
      const r = [...this.state.requests].reverse().find(r => r.status === 'queued');
      if (!r) return;
      r.status = 'reviewing'; this.save();
      try {
        if (r.destinationSignature !== this.context()) throw new Error('The messaging destination changed. Ask for a fresh request.');
        if (!this.currentSender(r)) throw new Error('The requesting teammate is no longer enabled.');
        const day = await this.refresh(), intent = requestIntent(r.text, day.events, this.calendar.state.rules, r.sender.id, day.timezone, this.now());
        if (!intent || intent.ambiguous) {
          r.status = 'unresolved'; r.note = 'No unique, enabled future meeting could be matched. Link this teammate to a flexible Calendar event and include its title or original start time.'; this.save();
          await this.send(r.sender, 'I could not identify one enabled meeting for this request. Please include its title and new time, for example “Move Coffee from 17:00 to 17:30”. The owner needs to link you to that flexible event in DayMade.');
          return;
        }
        r.participants = this.people().filter(p => this.calendar.state.rules[intent.event.id].personIds.includes(p.id)).map(p => ({ ...p }));
        r.event = intent.event; r.requestedTime = intent.time; r.day = day.day; r.timezone = day.timezone;
        const slot = requestSlot(day, intent.event, intent.time, this.now());
        if (slot.start === null) { r.status = 'unresolved'; r.note = 'The requested time is busy and there is no remaining free slot today.'; this.save(); await this.send(r.sender, 'That time is unavailable and I could not find another free slot today. The meeting has not changed.'); await this.notify(r, `DayMade · ${r.sender.name} requested a change\n${r.note}`); return; }
        if (slot.busy) { await this.activate(r, slot.start, true); return; }
        r.selectedTime = intent.time; r.status = 'awaiting_owner'; r.expiresAt = Math.min(r.expiresAt, this.now() + 10 * 60000); this.save();
        const names = this.people().filter(p => this.calendar.state.rules[intent.event.id].personIds.includes(p.id)).map(p => p.name).join(', ');
        await this.notify(r, `DayMade · ${r.sender.name} wants to reschedule\n\n“${r.text}”\n\n${intent.event.title}\n${day.day} · ${calendarRange(intent.event.start, intent.event.end, day.timezone)} → ${calendarRange(slot.start, slot.start + intent.event.end - intent.event.start, day.timezone)} (${day.timezone})\n\nCalendar says you’re free. Participants: ${names}. Accept this time, or suggest another? Acceptance lets me coordinate with the group and update Calendar once everyone agrees.`, [[{ text: `Accept ${intent.time}`, callback_data: `peerapprove:${r.id}` }, { text: 'Another time', callback_data: `peerother:${r.id}` }], [{ text: 'Decline request', callback_data: `peerreject:${r.id}` }]]);
      } catch (e) { r.status = 'unresolved'; r.note = (e as Error).message; this.save(); await this.notify(r, `DayMade · Request could not be completed\n${r.note}`); }
    } finally { this.busy = false; }
  }
  awaiting(id: string) {
    const r = this.state.requests.find(r => r.id === id);
    if (!this.state.enabled || !r || r.status !== 'awaiting_owner' || r.expiresAt <= this.now()) throw new Error('This teammate request expired or has already been handled. Open the latest request.');
    return r;
  }
  async action(id: string, choice: 'accept' | 'reject', time?: string) {
    if (this.busy) throw new Error('Wait for the current request to finish.');
    const r = this.awaiting(id);
    if (this.occupied() || this.calendar.active || this.calendar.state.plan?.status === 'draft') throw new Error('Another meeting is being coordinated. This request is still waiting.');
    this.busy = true;
    try {
      if (r.destinationSignature !== this.context()) throw new Error('The messaging destination changed. Ask for a fresh request.');
      if (!this.currentSender(r)) throw new Error('The requesting teammate changed or was disabled.');
      if (choice === 'reject') {
        r.status = 'declined'; r.note = 'You declined. The meeting stays at its original time.'; this.save();
        try { await this.send(r.sender, `The owner declined the change to “${r.event!.title}”. The meeting stays at ${calendarRange(r.event!.start, r.event!.end, r.timezone!)} (${r.timezone}).`); } catch { r.note += ' Delivery was not confirmed; no automatic retry.'; this.save(); }
        return;
      }
      const selected = time || r.requestedTime!;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(selected)) throw new Error('Reply with one time in 24-hour format, for example 17:45.');
      const day = await this.refresh();
      const event = day.events.find(e => e.id === r.event!.id);
      if (day.day !== r.day || !event || event.start !== r.event!.start || event.end !== r.event!.end || event.title !== r.event!.title) throw new Error('This meeting changed outside DayMade. Ask for a fresh request.');
      const people = this.people().filter(p => this.calendar.state.rules[event.id]?.personIds.includes(p.id));
      if (JSON.stringify(people) !== JSON.stringify(r.participants)) throw new Error('The meeting participants changed. Ask for a fresh request.');
      const slot = requestSlot(day, event, selected, this.now());
      if (slot.start === null) throw new Error('No free alternative remains today.');
      await this.activate(r, slot.start, slot.busy, selected);
    } finally { this.busy = false; }
  }
  private async activate(r: TeammateRequest, start: number, busy: boolean, selected = r.requestedTime!) {
    r.selectedTime = calendarTime(start, r.timezone!);
    const reason = busy ? `The requested ${selected} time is unavailable. I checked Calendar and found an alternative.` : `${r.sender.name} requested a time change, and the owner has approved coordination.`;
    const plan = await this.calendar.preparePeerChange(r.event!.id, start, { requestId: r.id, requesterId: r.sender.id, requestedTime: r.requestedTime!, originalText: r.text, sourceMessageId: r.incomingId, reason }, 10, r.event);
    r.planId = plan.id; r.status = 'coordinating'; r.note = reason; this.save();
    await this.calendar.approve(plan.id);
    if (plan.status === 'applied') { r.status = 'completed'; r.note = 'Everyone agreed. Calendar updated.'; this.save(); return; }
    if (plan.status !== 'coordinating') { r.status = 'unresolved'; r.note = plan.error || 'Coordination could not start.'; this.save(); return; }
    await this.notify(r, `DayMade · ${busy ? `${selected} was busy` : 'Your response was sent'}\n${r.event!.title}: coordinating ${r.selectedTime} (${r.timezone}) with the group. I’ll report the final agreed time here.`);
  }
}
