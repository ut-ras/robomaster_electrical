import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { authFromEnv } from './auth.ts';
import { providersFromEnv } from './catalog/index.ts';
import { Inventory } from './inventory.ts';
import { FileStore } from './store/file-store.ts';
import { SheetsStore, loadServiceAccount } from './store/sheets-store.ts';
import type { TableStore } from './store/tables.ts';

const env = process.env;
const sa = loadServiceAccount(env);
let store: TableStore;
if (sa && env.GOOGLE_SHEET_ID) store = new SheetsStore(sa, env.GOOGLE_SHEET_ID);
else store = new FileStore(resolve(import.meta.dirname, '..', '..', env.DEMO_SHEET_FILE ?? 'data/demo-sheet.json'));
await store.ensureTabs();

const providers = providersFromEnv(env);
const auth = authFromEnv(env);
const server = createApp({ inventory: new Inventory(store), providers, auth });
const port = Number(env.PORT ?? 8787);
server.listen(port, '0.0.0.0', () => {
  console.log(`Parts inventory on http://localhost:${port}`);
  for (const list of Object.values(networkInterfaces())) for (const n of list ?? []) {
    if (n.family === 'IPv4' && !n.internal) console.log(`  phones on this Wi-Fi: http://${n.address}:${port}`);
  }
  console.log(`  Mouser: ${providers.mouser.mode} | DigiKey: ${providers.digikey.mode} | storage: ${store.mode === 'sheets' ? 'Google Sheet ' + env.GOOGLE_SHEET_ID : 'local demo file (not Google Sheets)'}`);
  if (auth.demoMembers) console.log('  TEAM_MEMBERS not set: demo sign-ins "Demo One"/1111 and "Demo Two"/2222 are active. Set TEAM_MEMBERS before real use.');
  if (!env.SESSION_SECRET) console.log('  SESSION_SECRET not set: sign-ins reset when the server restarts.');
});
