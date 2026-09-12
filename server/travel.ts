import { randomUUID } from 'node:crypto';
import { calendarRange, calendarTime, type CalendarDay, type CalendarEvent } from '../shared/calendar.js';
import { safeJoinUrl, type MapRoute, type TravelEstimate, type TravelSettings, type TravelSnapshot } from '../shared/travel.js';
import type { CalendarAgent } from './calendar.js';
import { Store } from './store.js';

type Notice = { id: string; key: string; eventId: string; start: number; expiresAt: number };
type Button = { text: string; callback_data: string };
const minute = 60000;
export function arrivalSlot(day: CalendarDay, event: CalendarEvent, earliest: number, bufferMinutes: number) {
  const duration = event.end - event.start, buffer = bufferMinutes * minute;
  for (let at = Math.ceil(Math.max(earliest, event.start + minute) / (5 * minute)) * 5 * minute; at + duration <= day.dayEnd; at += 5 * minute) {
    if (day.events.every(e => e.id === event.id || !e.busy || at >= e.end + buffer || at + duration + buffer <= e.start)) return at;
  }
  return null;
}
export class TravelAgent {
  state: TravelSnapshot;
  private notices: Notice[];
  private checkedAt = 0;
  private generation = 0;
  private preparing = false;
  constructor(private store: Store, private calendar: CalendarAgent, private maps: (input: { origin: object; destination: object; mode: string }) => Promise<MapRoute>, private owner: (text: string, buttons?: Button[][]) => Promise<void>, private ready: () => boolean, private now = Date.now) {
    const settings = store.read<TravelSettings>('travel-settings', { enabled: false, mode: 'driving', bufferMinutes: 10, origin: null });
    this.state = { settings, estimate: null, status: 'Set your starting location to check travel.', error: null, notificationError: null, checking: false, online: [] };
    this.notices = store.read<Notice[]>('travel-notices', []).filter(n => n.expiresAt > now());
  }
  get working() { return this.preparing; }
  configure(change: Partial<TravelSettings>) {
    if (this.preparing) throw new Error('Wait for the proposed change to finish preparing.');
    this.generation++; this.checkedAt = 0;
    this.state.settings = { ...this.state.settings, ...change };
    this.state.estimate = null; this.state.error = null;
    this.state.status = this.state.settings.origin ? 'Ready to check Apple Maps.' : 'Set your starting location to check travel.';
    this.store.write('travel-settings', this.state.settings);
  }
  disconnect() { this.configure({ enabled: false, origin: null }); this.notices = []; this.store.write('travel-notices', []); }
  private originFresh() { const origin = this.state.settings.origin; return !!origin && this.now() - origin.updatedAt <= 30 * minute && origin.updatedAt <= this.now() && !(origin.accuracy && origin.accuracy > 1000); }
  private currentDay() { const c = this.calendar.state; return c.connected && !c.paused && c.day && this.now() >= c.day.dayStart && this.now() < c.day.dayEnd ? c.day : null; }
  async check(force = false) {
    if (this.state.checking) return;
    if (!force && this.now() - this.checkedAt < minute) return;
    this.state.checking = true; this.checkedAt = this.now(); const generation = this.generation;
    this.state.estimate = null; this.state.error = null;
    try {
      if (!this.calendar.state.connected || this.calendar.state.paused) { this.state.status = 'Connect Apple Calendar to check your real events.'; this.state.online = []; return; }
      if (this.calendar.working) { this.checkedAt = 0; this.state.status = 'Waiting for Calendar to finish.'; return; }
      await this.calendar.refresh();
      if (generation !== this.generation) return;
      const day = this.currentDay();
      if (!day) { this.state.status = 'Refresh today’s Calendar.'; return; }
      this.state.online = day.events.filter(e => e.online && !e.allDay && e.busy && e.end > this.now());
      const event = day.events.filter(e => !e.online && !e.allDay && e.busy && e.start > this.now()).sort((a, b) => a.start - b.start)[0];
      if (!event) { this.state.status = 'No upcoming in-person event today.'; return; }
      if (!event.location.trim() && !event.coordinates) { this.state.status = `“${event.title}” has no venue in Calendar. Add its real address there.`; return; }
      if (!this.originFresh()) { this.state.status = this.state.settings.origin ? 'Starting location is old or too imprecise. Update it to calculate a reliable departure time.' : 'Use your location or enter where you are now.'; return; }
      const { origin, mode, bufferMinutes } = this.state.settings;
      const route = await this.maps({ origin: origin!.coordinates || { address: origin!.address }, destination: event.coordinates || { address: event.location }, mode });
      if (generation !== this.generation || !this.originFresh() || !this.currentDay()) return;
      const latest = this.calendar.state.day?.events.find(e => e.id === event.id);
      if (!latest || latest.start !== event.start || latest.modified !== event.modified || latest.location !== event.location || latest.start <= this.now()) { this.state.status = 'Calendar changed during the route check. Refresh travel.'; return; }
      if (!Number.isFinite(route.seconds) || route.seconds <= 0 || !Number.isFinite(route.meters) || route.meters < 0) throw new Error('Apple Maps returned no usable travel estimate.');
      const travelMinutes = Math.ceil(route.seconds / 60), checkedAt = this.now(), total = (travelMinutes + bufferMinutes) * minute;
      this.state.estimate = { ...route, event: latest, checkedAt, travelMinutes, bufferMinutes, readyAt: checkedAt + total, leaveBy: event.start - total, lateMinutes: Math.max(0, Math.ceil((checkedAt + total - event.start) / minute)), mapsUrl: `https://maps.apple.com/?saddr=${route.origin.latitude},${route.origin.longitude}&daddr=${route.destination.latitude},${route.destination.longitude}&dirflg=${mode === 'walking' ? 'w' : 'd'}` };
      this.state.status = 'Route checked with Apple Maps. Arrival assumes you leave now.';
    } catch (e) { if (generation === this.generation) { this.state.estimate = null; this.state.error = (e as Error).message; this.state.status = 'Travel time is unavailable.'; } }
    finally { this.state.checking = false; }
  }
  private async notify(key: string, event: CalendarEvent, text: string, reschedule = false) {
    if (this.notices.some(n => n.key === key)) return;
    const notice = { id: randomUUID(), key, eventId: event.id, start: event.start, expiresAt: event.start };
    this.notices = this.notices.filter(n => n.expiresAt > this.now()); this.notices.push(notice);
    // Persist before sending. A timeout must not cause repeated owner messages.
    this.store.write('travel-notices', this.notices);
    try { await this.owner(text, reschedule ? [[{ text: 'Find a later time & review with me', callback_data: `tripplan:${notice.id}` }]] : undefined); this.state.notificationError = null; }
    catch (e) { this.state.notificationError = `Reminder delivery could not be confirmed: ${(e as Error).message}. Check Telegram; this reminder will not be resent automatically.`; }
  }
  async tick() {
    if (!this.state.settings.enabled || this.preparing) return;
    await this.check();
    if (!this.state.settings.enabled || !this.ready() || !this.currentDay() || this.state.checking || this.calendar.state.error) return;
    const day = this.currentDay()!;
    if (!this.calendar.state.refreshedAt || this.now() - this.calendar.state.refreshedAt > 2 * minute) return;
    for (const event of day.events.filter(e => e.online && !e.allDay && e.busy && e.start > this.now() && e.start - this.now() <= 10 * minute)) {
      const link = safeJoinUrl(event.joinUrl);
      await this.notify(`online:${event.id}:${event.start}`, event, `DayMade · Online meeting in ${Math.ceil((event.start - this.now()) / minute)} min\n${event.title}\n${calendarRange(event.start, event.end, day.timezone)} (${day.timezone})\n${link ? `Join: ${link}` : 'No meeting link in Calendar. Add the joining URL to this event.'}\nNo travel is needed for this online meeting.`);
    }
    const e = this.state.estimate;
    if (!e || !this.originFresh() || this.now() - e.checkedAt > 2 * minute || e.lateMinutes <= 0) return;
    const current = day.events.find(v => v.id === e.event.id);
    if (!current || current.start !== e.event.start || current.start <= this.now()) return;
    const canMove = current.editable && this.calendar.state.rules[current.id]?.flexible;
    const hasFriends = !!this.calendar.state.rules[current.id]?.personIds.length;
    await this.notify(`late:${current.id}:${current.start}`, current, `DayMade · You may not arrive on time\n${current.title} · ${calendarTime(current.start, day.timezone)} (${day.timezone})\nVenue: ${current.location || 'Calendar map location'}\nFrom: ${this.state.settings.origin!.label}\nApple Maps ${this.state.settings.mode}: ${e.travelMinutes} min + ${e.bufferMinutes} min buffer.\nReady around ${calendarTime(e.readyAt, day.timezone)} if you leave now — about ${e.lateMinutes} min late.\n${canMove ? hasFriends ? 'Would you like me to find a free time and ask your selected friends to move the meeting? Review the proposal before any friend is contacted.' : 'I can find a later time for this personal event. Select its friends in DayMade if you want me to contact them.' : 'This event is fixed. Open DayMade to enable rescheduling for an editable personal event and select its friends.'}\nDirections: ${e.mapsUrl}`, Boolean(canMove));
  }
  async propose(eventId: string, noticeId?: string) {
    if (this.preparing || this.state.checking || this.calendar.active) throw new Error('Wait for the current route or calendar operation to finish.');
    if (noticeId) {
      const n = this.notices.find(n => n.id === noticeId && n.expiresAt > this.now());
      if (!n || !this.state.settings.enabled || n.eventId !== eventId) throw new Error('This travel reminder expired. Refresh travel in DayMade.');
    }
    this.preparing = true;
    try {
      await this.check(true);
      const estimate = this.state.estimate, day = this.currentDay();
      if (!day || !estimate || estimate.event.id !== eventId || !this.originFresh() || estimate.lateMinutes <= 0) throw new Error('Refresh travel: this event no longer has a confirmed late-arrival estimate.');
      const start = arrivalSlot(day, estimate.event, estimate.readyAt, this.state.settings.bufferMinutes);
      if (start === null) throw new Error('No free slot remains today after your estimated arrival. Your calendar has not changed.');
      await this.calendar.reschedule(eventId, calendarTime(start, day.timezone), day.day, this.state.settings.bufferMinutes, estimate.readyAt);
    } finally { this.preparing = false; }
  }
  action(id: string) {
    const notice = this.notices.find(n => n.id === id);
    if (!notice) throw new Error('This travel reminder expired. Refresh travel in DayMade.');
    return this.propose(notice.eventId, id);
  }
}
