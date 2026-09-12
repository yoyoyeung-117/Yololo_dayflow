import { randomUUID } from 'node:crypto';
import type { CalendarDay, DayPlan, EventRule } from '../shared/calendar.js';

// Constraint-based scheduling is deliberately deterministic; model output cannot authorize a move.
export function planDay(day: CalendarDay, rules: Record<string, EventRule>, sourceId: string, extraMinutes: number, bufferMinutes: number, now = Date.now()): DayPlan {
  const source = day.events.find(e => e.id === sourceId);
  if (!source || source.allDay || !source.busy || source.start > now || source.end < now - 60 * 60_000) throw new Error('Choose an ongoing event or one that ended within the last hour.');
  if (!Number.isInteger(extraMinutes) || extraMinutes < 5 || extraMinutes > 120 || !Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 60) throw new Error('Use 5–120 extra minutes and a 0–60 minute transition buffer.');
  const assumedEnd = Math.max(now, source.end) + extraMinutes * 60_000;
  const plan: DayPlan = { id: randomUUID(), day: day.day, timezone: day.timezone, revision: day.revision, source, assumedEnd, bufferMinutes, changes: [], blockers: [], status: 'draft', createdAt: now, expiresAt: now + 10 * 60_000 };
  const buffer = bufferMinutes * 60_000;
  const remaining = day.events.filter(e => e.id !== source.id && !e.allDay && e.busy && e.end > now).sort((a, b) => a.start - b.start);
  const movable = (e: typeof source) => e.editable && e.start >= now && rules[e.id]?.flexible;
  const anchors = remaining.filter(e => !movable(e));
  for (const fixed of anchors) if (fixed.start < assumedEnd + buffer && fixed.end > now) plan.blockers.push(`“${fixed.title}” is fixed and conflicts with your extended event. Finish earlier or resolve it manually.`);
  let cursor = assumedEnd;
  for (const event of remaining.filter(movable)) {
    const duration = event.end - event.start;
    if (duration <= 0) { plan.blockers.push(`“${event.title}” has an invalid duration.`); continue; }
    let start = Math.max(event.start, cursor + buffer);
    if (start > event.start) start = Math.ceil(start / 300_000) * 300_000;
    for (const fixed of anchors) {
      if (start < fixed.end + buffer && start + duration + buffer > fixed.start) start = Math.ceil((fixed.end + buffer) / 300_000) * 300_000;
    }
    const end = start + duration;
    if (end > day.dayEnd) plan.blockers.push(`“${event.title}” would run past midnight. Choose a different day manually.`);
    if (start !== event.start) plan.changes.push({ event, start, end, personIds: [...(rules[event.id]?.personIds || [])] });
    cursor = end;
  }
  if (plan.changes.length > 8) plan.blockers.push('This plan affects more than eight events. Resolve part of the day manually first.');
  return plan;
}
