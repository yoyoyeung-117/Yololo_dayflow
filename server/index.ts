import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 4317);
const { app, webhookApp, webhookPort, start } = createApp(process.env.DAYFLOW_DATA_DIR);
const server = app.listen(port, '127.0.0.1', () => { console.log(`Dayflow is ready at http://localhost:${port}`); });
const webhookServer = webhookApp.listen(webhookPort, '127.0.0.1', () => { console.log(`Zoom authorization listener ready on port ${webhookPort} (dashboard stays private).`); });
const stop = start();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stop(); webhookServer.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
