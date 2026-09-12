import type { CalendarEvent } from './calendar.js';
import type { Coworker } from './types.js';
export type TeammateRequest = {
  id: string; incomingId: string; sender: Coworker; text: string; createdAt: number; expiresAt: number;
  status: 'queued' | 'reviewing' | 'awaiting_owner' | 'coordinating' | 'completed' | 'declined' | 'expired' | 'unresolved' | 'paused';
  event?: CalendarEvent; requestedTime?: string; selectedTime?: string; day?: string; timezone?: string;
  participants?: Coworker[]; destinationSignature?: string;
  planId?: string; note?: string; notificationError?: string;
};
export type RequestSnapshot = { enabled: boolean; since: number; requests: TeammateRequest[]; error: string | null };
