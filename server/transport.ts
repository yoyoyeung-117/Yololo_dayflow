import type { Person, Platform, Proposal } from '../shared/types.js';

export class SendFailure extends Error {
  constructor(message: string, public definitive: boolean) { super(message); }
}
export type Receipt = { id: string; createdDateTime: string; delivery?: 'sent' | 'queued' };
export type Incoming = { platform: Platform; sender: string; text: string; messageId: string; quotedId?: string; at: number };

// The transport authenticates the sender. This function binds their words to one approved proposal.
export function correlateReply(event: Incoming, proposal: Proposal): { personId: string; text: string; messageId: string } | null {
  if (proposal.mode !== 'live' || !proposal.approvedAt || !proposal.sentAt || !Number.isFinite(event.at) || event.at < proposal.sentAt - 1000) return null;
  const person = proposal.people.find(p => p.platform === event.platform && p.address?.toLowerCase() === event.sender.toLowerCase());
  if (!person || !person.messageId || person.delivery === 'not_sent' || !event.text.trim()) return null;
  const codes = event.text.match(/#DF-[A-F0-9]{6}\b/gi)?.map(code => code.toUpperCase()) || [];
  if (codes.some(code => code !== proposal.code)) return null;
  if (event.quotedId !== person.messageId && !codes.includes(proposal.code)) return null;
  const text = event.text.replace(new RegExp(proposal.code, 'gi'), '').replace(/^\s*[:\-–]\s*/, '').trim();
  return text ? { personId: person.id, text: text.slice(0, 2000), messageId: `${event.platform}:${event.messageId}` } : null;
}
export function recipientLabel(person: Pick<Person, 'name' | 'platform' | 'address'>) {
  return `${person.name}${person.platform ? ` · ${person.platform === 'zoom' ? 'Zoom Team Chat' : person.platform} (${person.address})` : ''}`;
}
