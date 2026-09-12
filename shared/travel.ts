import type { CalendarEvent } from './calendar.js';
export type Coordinates = { latitude: number; longitude: number };
export type TravelOrigin = { label: string; address?: string; coordinates?: Coordinates; source: 'browser' | 'address'; updatedAt: number; accuracy?: number };
export type TravelSettings = { enabled: boolean; mode: 'walking' | 'driving'; bufferMinutes: number; origin: TravelOrigin | null };
export type MapRoute = { originName?: string; destinationName?: string; seconds: number; meters: number; origin: Coordinates; destination: Coordinates; mapImage?: string; provider: 'Apple Maps' };
export type TravelEstimate = MapRoute & { event: CalendarEvent; checkedAt: number; travelMinutes: number; bufferMinutes: number; readyAt: number; leaveBy: number; lateMinutes: number; mapsUrl: string };
export type TravelSnapshot = { settings: TravelSettings; estimate: TravelEstimate | null; status: string; error: string | null; notificationError: string | null; checking: boolean; online: CalendarEvent[] };
export function safeJoinUrl(value?: string) {
  try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function venueMapUrl(event: CalendarEvent) { const q = event.coordinates ? `${event.coordinates.latitude},${event.coordinates.longitude}` : event.location; return q ? `https://maps.apple.com/?q=${encodeURIComponent(q)}` : null; }
