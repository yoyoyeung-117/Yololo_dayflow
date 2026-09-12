export type Mode = 'replay' | 'live';
export type Platform = 'telegram' | 'discord' | 'zoom';
export const platformNames: Record<Platform, string> = { telegram: 'Telegram', discord: 'Discord', zoom: 'Zoom Team Chat' };
export type Coworker = { id: string; name: string; platform: Platform; address: string; enabled: boolean };
export type Phase = 'observing' | 'preparing' | 'approval' | 'sending' | 'waiting' | 'agreed' | 'attention' | 'dismissed' | 'uncertain';
export type ReplyStatus = 'pending' | 'accepted' | 'declined' | 'counterproposal' | 'unclear';
export type Delivery = 'not_sent' | 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'uncertain';
export type Person = { id: string; name: string; platform?: Platform; address?: string; status: ReplyStatus; text?: string; proposedTime?: string; messageId?: string; delivery?: Delivery; deliveryError?: string };
export type Proposal = {
  id: string; code: string; time: string; endTime: string; text: string;
  createdAt: number; expiresAt: number; approvedAt?: number; sentAt?: number;
  messageId?: string; destinationId?: string; destinationName: string; people: Person[];
  ai: boolean; aiNote?: string; mode: Mode; transport: 'social';
};
export type Activity = { id: string; at: number; title: string; detail: string; kind: 'info' | 'success' | 'warning' };
export type State = {
  version: number; mode: Mode; phase: Phase; clock: string;
  proposal: Proposal | null; activity: Activity[];
  processedMessages: string[]; error: string | null;
  summary: string | null; telegramNotificationError: string | null;
};
export type Settings = {
  coworkers: Coworker[];
  telegramToken: string; telegramOwnerChatId: string;
  discordToken: string; discordChannelId: string;
  zoomClientId: string; zoomClientSecret: string; zoomRedirectBaseUrl: string;
  ollamaUrl: string; ollamaModel: string;
};
export type IntegrationStatus = {
  ready: boolean;
  coworkers: (Coworker & { ready: boolean; reason: string; inviteUrl?: string; inviteExpiresAt?: number })[];
  telegram: { configured: boolean; connected: boolean; paired: boolean; username: string | null; pairingCode: string | null; error: string | null };
  discord: { configured: boolean; connected: boolean; channelName: string | null; botName: string | null; error: string | null };
  zoom: { configured: boolean; connected: boolean; account: string | null; error: string | null; redirectUrl: string; tunnel: { running: boolean; url: string | null; error: string | null } };
  llm: { available: boolean; model: string; models: string[]; error: string | null };
};
export type PublicSettings = Omit<Settings, 'telegramToken' | 'discordToken' | 'zoomClientSecret'>;
export type Snapshot = { state: State; integrations: IntegrationStatus; settings: PublicSettings };
