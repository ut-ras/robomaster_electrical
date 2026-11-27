// Explicitly isolated demo: never loads .env, credentials, Google Sheets, or an inventory file.
import { createApp } from '../src/server/app.ts';
import { authFromEnv } from '../src/server/auth.ts';
import { providersFromEnv } from '../src/server/catalog/index.ts';
import { Inventory } from '../src/server/inventory.ts';
import { FileStore } from '../src/server/store/file-store.ts';

const store = new FileStore();
await store.ensureTabs();
const server = createApp({ inventory: new Inventory(store), providers: providersFromEnv({}), auth: authFromEnv({ SESSION_SECRET: 'local-demo-only' }) });
const port = Number(process.env.PORT ?? 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`Isolated inventory demo: http://localhost:${port}`);
  console.log('Sign in as Demo One / 1111 or Demo Two / 2222. All data resets on restart.');
  console.log('Try Mouser 771-74LVC244APW-T or DigiKey 495-75588-ND. No live services are used.');
});
