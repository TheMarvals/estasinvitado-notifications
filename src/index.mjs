import { Store } from './store.mjs';
import { createApi } from './server.mjs';
import { startWorker } from './worker.mjs';

if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required');
if (!process.env.ADMIN_API_KEY || process.env.ADMIN_API_KEY.length < 32) throw new Error('ADMIN_API_KEY must contain at least 32 characters');
const store = new Store(process.env.DATABASE_PATH || './.local/notifications.sqlite');
const server = createApi({ store, adminKey: process.env.ADMIN_API_KEY, defaultFrom: process.env.RESEND_FROM });
const stopWorker = startWorker(store, { apiKey: process.env.RESEND_API_KEY });
server.listen(Number(process.env.PORT || 3001), process.env.HOST || '0.0.0.0', () => console.log('Notification service is ready'));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise(resolve => server.close(resolve));
  await stopWorker();
  store.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
