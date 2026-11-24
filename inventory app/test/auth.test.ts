// Sign-in accepts letters-and-digits passcodes and keeps numeric PINs as exact strings (leading zeros matter).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.ts';
import { authFromEnv } from '../src/server/auth.ts';
import { DemoDigikey, DemoMouser } from '../src/server/catalog/index.ts';
import { Inventory } from '../src/server/inventory.ts';
import { FileStore } from '../src/server/store/file-store.ts';

test('sign-in with a mixed passcode and a numeric PIN with leading zeros', async () => {
  const auth = authFromEnv({ TEAM_MEMBERS: 'Robo Tester:RoboTest7, Zero Pin:0042', SESSION_SECRET: 'auth-test' });
  const server = createApp({ inventory: new Inventory(new FileStore()), providers: { mouser: new DemoMouser(), digikey: new DemoDigikey() }, auth });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (name: string, pin: unknown) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name, pin }) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const robo = await login('Robo Tester', 'RoboTest7');
    assert.equal(robo.status, 200);
    assert.equal(robo.body.member, 'Robo Tester');
    // The token works on a members-only endpoint.
    const drawers = await fetch(`${base}/api/drawers`, { headers: { Authorization: `Bearer ${robo.body.token}` } });
    assert.equal(drawers.status, 200);

    const zero = await login('zero pin', '0042');
    assert.equal(zero.status, 200);
    assert.equal(zero.body.member, 'Zero Pin');

    assert.equal((await login('Robo Tester', 'robotest7')).status, 401, 'passcodes are case-sensitive');
    assert.equal((await login('Robo Tester', 'RoboTest')).status, 401);
    assert.equal((await login('Zero Pin', '42')).status, 401, 'leading zeros are significant');
    assert.equal((await login('Zero Pin', 42)).status, 400, 'a PIN sent as a JSON number is refused, never coerced');
  } finally {
    server.close();
  }
});
