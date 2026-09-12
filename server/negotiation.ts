import type { CalendarDay } from '../shared/calendar.js';
import { calendarTime } from '../shared/calendar.js';
import type { Proposal } from '../shared/types.js';
export type NegotiatedSlot = { time: string; endTime: string; day: string; timezone: string; start: number; end: number; reason: string };
export type BusySlot = { start: number; end: number };
export function nextSlot(day: CalendarDay, proposal: Proposal, busy: BusySlot[], earliest: number, bufferMinutes: number, now = Date.now()): NegotiatedSlot | null {
  const grant = proposal.negotiation;
  if (!grant || grant.round >= grant.maxRounds || now >= grant.deadline) return null;
  const minutes = (time: string) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
  const duration = (minutes(proposal.endTime) - minutes(proposal.time)) * 60000;
  if (duration <= 0) return null;
  const buffer = bufferMinutes * 60000;
  const lower = Math.max(earliest, now + 60000);
  const rejected = new Set([...grant.history.map(h => h.time), proposal.time]);
  const available = (start: number) => start >= lower && start + duration <= day.dayEnd && !rejected.has(calendarTime(start, day.timezone)) && busy.every(b => start >= b.end + buffer || start + duration + buffer <= b.start);
  // Enumerate the actual local day, including DST transitions, rather than parsing wall time as UTC.
  const candidates: number[] = [];
  for (let at = Math.ceil(day.dayStart / 300000) * 300000; at + duration <= day.dayEnd; at += 300000) candidates.push(at);
  const preferred = proposal.people.filter(p => p.status === 'counterproposal' && p.proposedTime).map(p => p.proposedTime!);
  for (const time of preferred) {
    let start: number | undefined;
    for (let at = Math.ceil(day.dayStart / 60000) * 60000; at + duration <= day.dayEnd; at += 60000) {
      if (calendarTime(at, day.timezone) === time && available(at)) { start = at; break; }
    }
    if (start !== undefined) return { time, endTime: calendarTime(start + duration, day.timezone), start, end: start + duration, day: day.day, timezone: day.timezone, reason: `A friend suggested ${time}; Calendar confirms this slot is free.` };
  }
  const afterCurrent = candidates.find(at => calendarTime(at, day.timezone) === proposal.time);
  const start = candidates.find(at => at >= (afterCurrent === undefined ? lower : afterCurrent + 15 * 60000) && available(at));
  if (start === undefined) return null;
  return { time: calendarTime(start, day.timezone), endTime: calendarTime(start + duration, day.timezone), start, end: start + duration, day: day.day, timezone: day.timezone, reason: preferred.length ? 'The suggested time is busy or was already tried. Calendar has room in this next slot.' : 'A friend declined. Calendar has room in this next slot.' };
}
export const negotiationPolicy = 'I’ll handle alternative times today without asking you again: same people and duration, up to 6 proposals over 30 minutes. Every changed time needs everyone’s agreement. If no slot works, I’ll report that.';
