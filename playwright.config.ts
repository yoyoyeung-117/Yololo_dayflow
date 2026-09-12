import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 30000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4318', viewport: { width: 1440, height: 1100 }, screenshot: 'only-on-failure' },
  webServer: { command: 'DAYFLOW_DATA_DIR=.local/e2e PORT=4318 WEBHOOK_PORT=4320 OLLAMA_URL=http://127.0.0.1:1 npm start', url: 'http://127.0.0.1:4318/api/state', reuseExistingServer: false },
});
