import type { State } from './types.js';
export type CalendarEvent = { id: string; eventIdentifier: string; calendarId: string; calendarName: string; title: string; start: number; end: number; allDay: boolean; editable: boolean; hasAttendees: boolean; recurring: boolean; location: string; modified: number; busy: boolean };
export type CalendarDay = { day: string; dayStart: number; dayEnd: number; timezone: string; revision: string; events: CalendarEvent[]; calendars: { id: string; name: string; source: string; writable: boolean }[] };
export type EventRule = { flexible: boolean; personIds: string[] };
export type CalendarChange = { event: CalendarEvent; start: number; end: number; personIds: string[]; conversation?: State };
export type DayPlan = { id: string; day: string; timezone: string; revision: string; source: CalendarEvent; assumedEnd: number; bufferMinutes: number; changes: CalendarChange[]; blockers: string[]; status: 'draft' | 'coordinating' | 'attention' | 'applying' | 'applied' | 'dismissed' | 'uncertain'; createdAt: number; expiresAt: number; approvedAt?: number; appliedAt?: number; error?: string; receipts?: { id: string; start: number; end: number }[] };
export type CalendarSnapshot = { connected: boolean; error: string | null; notificationError: string | null; day: CalendarDay | null; rules: Record<string, EventRule>; monitoring: boolean; plan: DayPlan | null; refreshedAt: number | null };
export function calendarTime(at: number, timezone: string) { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(at); }
export function calendarRange(start: number, end: number, timezone: string) { return `${calendarTime(start, timezone)}–${calendarTime(end, timezone)}`; }
