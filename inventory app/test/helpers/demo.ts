import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server/app.ts';
import { authFromEnv } from '../../src/server/auth.ts';
import { providersFromEnv } from '../../src/server/catalog/index.ts';
import { Inventory } from '../../src/server/inventory.ts';
import { FileStore } from '../../src/server/store/file-store.ts';

export async function demo(t: TestContext) {
  const store = new FileStore();
  await store.ensureTabs();
  const inventory = new Inventory(store);
  const providers = providersFromEnv({});
  const server = createApp({ inventory, providers, auth: authFromEnv({ SESSION_SECRET: 'receiving-tests' }) });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ name: 'Demo One', pin: '1111' }) });
  const { token } = await login.json();
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };
  const part = (await request('/api/identify', { supplier: 'mouser', sku: '771-74LVC244APW-T' })).chosen;
  return { store, inventory, providers, request, part, base, token };
}
