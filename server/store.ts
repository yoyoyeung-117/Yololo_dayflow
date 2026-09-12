import fs from 'node:fs';
import path from 'node:path';
import type { Settings, State } from '../shared/types.js';

export class Store {
  constructor(public directory: string) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  read<T>(name: string, fallback: T): T {
    try { return JSON.parse(fs.readFileSync(path.join(this.directory, `${name}.json`), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${name}.json. Restore or remove the damaged local file.`); }
  }
  write(name: string, value: unknown) {
    const target = path.join(this.directory, `${name}.json`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  }
}

export const defaults = (): Settings => ({
  coworkers: [],
  discordToken: process.env.DISCORD_BOT_TOKEN || '',
  discordChannelId: process.env.DISCORD_CHANNEL_ID || '',
  zoomClientId: process.env.ZOOM_CLIENT_ID || '',
  zoomClientSecret: process.env.ZOOM_CLIENT_SECRET || '',
  zoomRedirectBaseUrl: process.env.ZOOM_REDIRECT_BASE_URL || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramOwnerChatId: process.env.TELEGRAM_OWNER_CHAT_ID || '',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:4b',
});

export const initialState = (): State => ({
  version: 1, mode: 'replay', phase: 'observing', clock: '13:00', proposal: null,
  activity: [], processedMessages: [], error: null, summary: null, telegramNotificationError: null,
});
