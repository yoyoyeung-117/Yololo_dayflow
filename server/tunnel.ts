import { spawn, type ChildProcess } from 'node:child_process';

export class ReplyTunnel {
  private process: ChildProcess | null = null;
  status = { running: false, url: null as string | null, error: null as string | null };
  constructor(private port: number, private onUrl: (url: string) => void) {}
  start() {
    if (this.process) return;
    this.status = { running: true, url: null, error: null };
    // Only the OAuth callback listener is exposed. The dashboard/API uses a different port.
    const process = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = process;
    const timeout = setTimeout(() => { if (!this.status.url) { this.status.error = 'The Zoom authorization connection did not start. Check your internet connection and try again.'; process.kill('SIGTERM'); } }, 35000); timeout.unref();
    let buffer = '';
    const read = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-16000);
      const url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
      if (url && !this.status.url) { clearTimeout(timeout); this.status.url = url; this.onUrl(url); }
    };
    process.stdout?.on('data', read); process.stderr?.on('data', read);
    process.on('error', () => { this.status = { running: false, url: null, error: 'Install cloudflared, then start the Zoom authorization connection again. On macOS: brew install cloudflared' }; this.process = null; });
    process.on('exit', () => { clearTimeout(timeout); this.process = null; this.status.running = false; if (!this.status.error) this.status.error = 'The Zoom authorization connection stopped. Restart it and update the redirect URL in Zoom.'; });
  }
  stop() { this.process?.kill('SIGTERM'); }
}
