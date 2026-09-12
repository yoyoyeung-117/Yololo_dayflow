import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const port = process.env.PORT || '4317';
const url = `http://localhost:${port}`;
const settings = fs.existsSync('.local/settings.json') ? JSON.parse(fs.readFileSync('.local/settings.json', 'utf8')) : {};
const ollamaUrl = settings.ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const model = settings.ollamaModel || process.env.OLLAMA_MODEL || 'qwen3.6:35b';
const children = [];
const ready = async endpoint => { try { return (await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
const openBrowser = () => { if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' }).unref(); };

if (await ready(`${url}/api/state`)) {
  console.log(`Dayflow is already running at ${url}`); openBrowser(); process.exit(0);
}
if (!fs.existsSync('dist/index.html')) {
  if (spawnSync('npm', ['run', 'build'], { stdio: 'inherit' }).status !== 0) process.exit(1);
}
if (!(await ready(`${ollamaUrl}/api/tags`))) {
  console.log('Starting Ollama…');
  fs.mkdirSync('.local', { recursive: true, mode: 0o700 });
  const log = fs.openSync('.local/ollama.log', 'a', 0o600);
  const ollama = spawn('ollama', ['serve'], { stdio: ['ignore', log, log] });
  ollama.on('error', () => console.log('Ollama is not installed. Install it from https://ollama.com/download and run: ollama pull ' + model));
  children.push(ollama);
  for (let i = 0; i < 20 && !(await ready(`${ollamaUrl}/api/tags`)); i++) await new Promise(resolve => setTimeout(resolve, 300));
}
if (await ready(`${ollamaUrl}/api/tags`)) {
  const tags = await fetch(`${ollamaUrl}/api/tags`).then(r => r.json());
  if (!tags.models.some(entry => entry.name === model)) console.log(`Model not downloaded yet. In another terminal run: ollama pull ${model}`);
}
console.log('Starting Dayflow. Keep this terminal open; press Ctrl+C to stop.');
const server = spawn('npm', ['start'], { stdio: 'inherit' }); children.push(server);
const shutdown = () => { for (const child of children) child.kill('SIGTERM'); setTimeout(() => process.exit(), 1500).unref(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('exit', shutdown);
for (let i = 0; i < 40; i++) {
  if (await ready(`${url}/api/state`)) { console.log(`Open ${url}`); openBrowser(); break; }
  await new Promise(resolve => setTimeout(resolve, 300));
}
