// The Google Sheet link is public (no app sign-in) and is the only Sheet detail the browser receives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.ts';
import { authFromEnv } from '../src/server/auth.ts';
import { DemoDigikey, DemoMouser } from '../src/server/catalog/index.ts';
import { Inventory } from '../src/server/inventory.ts';
import { FileStore } from '../src/server/store/file-store.ts';
import { SheetsStore } from '../src/server/store/sheets-store.ts';
import type { TableStore } from '../src/server/store/tables.ts';

const SHEET_ID = '1AbC-test_SheetId0123456789xyz';
const FAKE_SA = { client_email: 'svc-test@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nTESTKEYMATERIAL\n-----END PRIVATE KEY-----\n', token_uri: 'https://oauth2.googleapis.com/token' };

async function withServer(store: TableStore, fn: (base: string) => Promise<void>) {
  const auth = authFromEnv({ TEAM_MEMBERS: 'Ana:0042', SESSION_SECRET: 'sheet-link-test' });
  const server = createApp({ inventory: new Inventory(store), providers: { mouser: new DemoMouser(), digikey: new DemoDigikey() }, auth });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

test('signed-out status gives the Sheet link and nothing else about Google', async () => {
  await withServer(new SheetsStore(FAKE_SA as any, SHEET_ID), async (base) => {
    const res = await fetch(`${base}/api/status`); // no Authorization header
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(JSON.parse(text).sheetUrl, `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
    for (const secret of ['PRIVATE KEY', 'TESTKEYMATERIAL', FAKE_SA.client_email, 'oauth2']) assert.ok(!text.includes(secret), `status leaks ${secret}`);
    // Writing still needs an app sign-in.
    assert.equal((await fetch(`${base}/api/parts`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/stock`, { method: 'POST', body: '{}' })).status, 401);
  });
});

test('no Sheet link when storage is the local demo file', async () => {
  await withServer(new FileStore(), async (base) => {
    const s = await (await fetch(`${base}/api/status`)).json();
    assert.equal(s.sheetUrl, undefined);
  });
});
