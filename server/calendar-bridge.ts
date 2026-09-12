import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { CalendarDay, DayPlan } from '../shared/calendar.js';
const execute = promisify(execFile);
export interface CalendarBridge { read(connect?: boolean): Promise<CalendarDay>; apply(plan: DayPlan): Promise<{ id: string; start: number; end: number }[]> }
export function localDay(now = new Date()) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
export class AppleCalendar implements CalendarBridge {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private call(input: object): Promise<any> {
    const result = this.queue.then(async () => {
      if (process.platform !== 'darwin') throw new Error('Apple Calendar requires Dayflow to run on your Mac.');
      const app = path.resolve('.local/Dayflow Calendar.app');
      try { await fs.access(app); } catch { throw new Error('Build the Calendar helper first: npm run calendar:build'); }
      const folder = path.join(this.directory, 'calendar-requests'); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const id = randomUUID(), request = path.join(folder, `${id}.request.json`), response = path.join(folder, `${id}.response.json`);
      try {
        await fs.writeFile(request, JSON.stringify(input), { mode: 0o600 });
        await execute('/usr/bin/open', ['-W', '-n', app, '--args', '--request', request, '--response', response], { timeout: 120_000 });
        const value = JSON.parse(await fs.readFile(response, 'utf8'));
        if (!value.ok) throw new Error(value.error || 'Calendar operation failed.');
        return value;
      } finally { await Promise.allSettled([fs.unlink(request), fs.unlink(response)]); }
    });
    this.queue = result.catch(() => {}); return result;
  }
  read(connect = false) { return this.call({ action: connect ? 'connect' : 'read', day: localDay() }) as Promise<CalendarDay>; }
  async apply(plan: DayPlan) { const value = await this.call({ action: 'apply', day: plan.day, revision: plan.revision, bufferMinutes: plan.bufferMinutes, changes: plan.changes.map(c => ({ id: c.event.id, start: c.start, end: c.end })) }); return value.receipts; }
}
