import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { FileStore } from '../src/server/store/file-store.ts';
import { SheetsStore } from '../src/server/store/sheets-store.ts';
import { TABS, toCells, type TabId } from '../src/server/store/tables.ts';
import { demo } from './helpers/demo.ts';
import { client } from './helpers/client.ts';

const tabs = Object.keys(TABS) as TabId[];
async function seed(d: Awaited<ReturnType<typeof demo>>) {
  const a = await d.request('/api/parts', { requestId: 'save-a', drawer: 'A3', part: d.part });
  const other = (await d.request('/api/identify', { supplier: 'digikey', sku: 'WM20054-ND' })).chosen;
  const b = await d.request('/api/parts', { requestId: 'save-b', drawer: 'B2', part: other });
  await d.request('/api/stock', { requestId: 'stock-a', partId: a.partId, drawer: 'A3', delta: 12 });
  await d.request('/api/stock', { requestId: 'stock-b', partId: b.partId, drawer: 'B2', delta: 7 });
  return { a, b };
}

test('demo DELETE removes only the exact part across all five tabs, preserving another part and its stock', async (t) => {
  const d = await demo(t); const { a, b } = await seed(d);
  const otherBefore = await d.request(`/api/parts/${b.partId}`);
  const before = await Promise.all(tabs.map(tab => d.store.read(tab)));
  for (const rows of before) assert.ok(rows.some(row => row.part_id === a.partId), 'target has records in every tab');
  const response = await fetch(`${d.base}/api/parts/${a.partId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${d.token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { partId: a.partId, name: d.part.mpn });
  for (const [i, tab] of tabs.entries()) assert.deepEqual(await d.store.read(tab), before[i].filter(row => row.part_id !== a.partId), tab);
  assert.deepEqual(await d.request(`/api/parts/${b.partId}`), otherBefore);
  assert.deepEqual(otherBefore.locations, [{ drawer: 'B2', qty: 7 }]);
  assert.equal((await fetch(`${d.base}/api/parts/${a.partId}`, { headers: { Authorization: `Bearer ${d.token}` } })).status, 404);
  assert.equal((await d.request(`/api/search?q=${encodeURIComponent(d.part.sku)}`)).hits.length, 0);
  // A repeated request after a lost response is safe and does not affect any other part.
  assert.equal((await fetch(`${d.base}/api/parts/${a.partId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${d.token}` } })).status, 200);
  assert.deepEqual(await d.request(`/api/parts/${b.partId}`), otherBefore);
});

test('DELETE requires team sign-in; an ID prefix or malformed route cannot delete other parts', async (t) => {
  const d = await demo(t); const { a } = await seed(d);
  const before = structuredClone(d.store.data);
  assert.equal((await fetch(`${d.base}/api/parts/${a.partId}`, { method: 'DELETE' })).status, 401);
  for (const route of ['/api/parts', '/api/parts/all', `/api/parts/${a.partId}/history`]) {
    assert.equal((await fetch(d.base + route, { method: 'DELETE', headers: { Authorization: `Bearer ${d.token}` } })).status, 404);
  }
  await d.inventory.deletePart(a.partId.slice(0, -1));
  await assert.rejects(d.inventory.deletePart(''), /Invalid inventory ID/);
  assert.deepEqual(d.store.data, before);
});

test('FileStore persists exact-ID deletion, preserving headers, similar IDs and unrelated cell values', async (t) => {
  const file = join(tmpdir(), `inventory-delete-${randomUUID()}.json`);
  const store = new FileStore(file); await store.ensureTabs(); t.after(() => unlink(file));
  for (const tab of tabs) await store.append(tab, [
    { part_id: 'P-abc123', name: 'remove' },
    { part_id: 'P-abc1234', name: 'P-abc123', sku: 'P-abc123' },
    { part_id: 'p-abc123', name: 'case differs' },
    { part_id: '', name: 'no id' },
    { part_id: 'P-abc123', name: 'remove too' },
  ]);
  const before = structuredClone(store.data);
  await store.deleteByPartId('P-abc123');
  const loaded = new FileStore(file);
  for (const tab of tabs) {
    const layout = TABS[tab]; const column = layout.header.indexOf('part_id');
    assert.deepEqual(loaded.data[layout.name], before[layout.name].filter((cells, i) => i === 0 || cells[column] !== 'P-abc123'));
  }
  await assert.rejects(store.deleteByPartId(''), /partId required/);
});

test('Sheets deletion batches only exact matching row ranges, bottom-up, without rewriting other records', async () => {
  const target = 'P-abc123';
  const ids = ['P-other', target, target, 'P-abc1234', target, '', target, 'p-abc123', target];
  const data = Object.fromEntries(tabs.map(tab => [tab, [
    [...TABS[tab].header], ...ids.map(part_id => toCells(tab, { part_id, name: target, sku: target, note: target })),
  ]])) as Record<TabId, string[][]>;
  const before = structuredClone(data);
  const batches: any[] = [];
  const store = new SheetsStore({ client_email: 'demo@example.invalid', private_key: 'unused' }, 'demo-sheet');
  let failRead = false;
  // Stub the transport: no Google request or credential is used.
  (store as any).api = async (path: string, init: RequestInit = {}) => {
    if (path === '?fields=sheets.properties') return { sheets: tabs.map((tab, sheetId) => ({ properties: { title: TABS[tab].name, sheetId } })) };
    if (path.startsWith('/values/')) {
      const tab = tabs.find(tab => decodeURIComponent(path).includes(`'${TABS[tab].name}'!`))!;
      if (failRead && tab === 'ledger') throw new Error('read failed');
      return { values: data[tab].slice(1) };
    }
    assert.equal(path, ':batchUpdate'); assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body as string); batches.push(body);
    for (const request of body.requests) {
      const { sheetId, dimension, startIndex, endIndex } = request.deleteDimension.range;
      assert.equal(dimension, 'ROWS'); assert.ok(startIndex >= 1, 'never delete a header');
      const tab = tabs[sheetId]; const column = TABS[tab].header.indexOf('part_id');
      assert.ok(data[tab].slice(startIndex, endIndex).every(cells => cells[column] === target), 'every deleted row has the exact target id');
      data[tab].splice(startIndex, endIndex - startIndex);
    }
    return {};
  };
  failRead = true;
  await assert.rejects(store.deleteByPartId(target), /read failed/);
  assert.equal(batches.length, 0); assert.deepEqual(data, before);
  failRead = false; await store.deleteByPartId(target);
  assert.equal(batches.length, 1, 'all five tabs use a single batch');
  for (const tab of tabs) {
    const column = TABS[tab].header.indexOf('part_id');
    assert.deepEqual(data[tab], before[tab].filter((cells, i) => i === 0 || cells[column] !== target), tab);
  }
  await store.deleteByPartId(target); assert.equal(batches.length, 1, 'retry with no remaining matches does not write');
  await assert.rejects(store.deleteByPartId(''), /partId required/);
});

test('detail confirmation names the part and ID, Cancel does nothing, and success returns to Search', async (t) => {
  const d = await demo(t); const { b } = await seed(d);
  const hw = await d.request('/api/hardware', { requestId: 'washer', name: 'Loose M3 washers', category: 'washer', drawer: 'C1' });
  await d.request('/api/stock', { requestId: 'washer-stock', partId: hw.partId, drawer: 'C1', delta: 4 });
  let approve = false;
  const ui = await client(d, undefined, () => approve);
  await ui.renderPart(hw.partId); ui.button('− Take');
  await ui.button('Delete part').click();
  const confirmation = ui.confirmations[0];
  for (const text of ['Loose M3 washers', `Inventory ID: ${hw.partId}`, 'permanently', 'stock history', 'associated records', 'cannot be undone']) assert.ok(confirmation.includes(text), text);
  assert.equal(ui.requests.filter(r => r.method === 'DELETE').length, 0);
  assert.equal((await d.request(`/api/parts/${hw.partId}`)).locations[0].qty, 4);
  approve = true;
  const button = ui.button('Delete part'); await Promise.all([button.click(), button.click()]); await ui.idle();
  assert.equal(ui.requests.filter(r => r.method === 'DELETE').length, 1);
  ui.input('Search inventory');
  assert.ok(ui.view.textContent.includes(`Deleted Loose M3 washers (Inventory ID: ${hw.partId})`));
  assert.equal((await d.request(`/api/parts/${b.partId}`)).locations[0].qty, 7);
});

test('lost deletion response leaves a retryable detail page and does not delete another part', async (t) => {
  const d = await demo(t); const { a, b } = await seed(d);
  let armed = false;
  const ui = await client(d, async path => {
    if (armed && path === `/api/parts/${a.partId}`) {
      armed = false;
      await fetch(d.base + path, { method: 'DELETE', headers: { Authorization: `Bearer ${d.token}` } });
      throw new Error('response lost');
    }
    return undefined;
  }, () => true);
  await ui.renderPart(a.partId); armed = true;
  await ui.button('Delete part').click();
  assert.ok(ui.view.textContent.includes('Deletion could not be confirmed')); assert.equal(ui.button('Delete part').disabled, false);
  await ui.button('Delete part').click(); await ui.idle();
  ui.input('Search inventory'); assert.ok(ui.view.textContent.includes(`Deleted ${d.part.mpn}`));
  assert.equal((await d.request(`/api/parts/${b.partId}`)).locations[0].qty, 7);
});

test('− Take still adjusts stock without deleting the part or its other records', async (t) => {
  const d = await demo(t); const { a } = await seed(d); const ui = await client(d);
  await ui.renderPart(a.partId);
  ui.all().find(el => el.attrs.placeholder === 'qty')!.value = '2';
  await ui.button('− Take').click(); await ui.idle();
  const part = await d.request(`/api/parts/${a.partId}`);
  assert.equal(part.locations[0].qty, 10); assert.equal(part.history.length, 2); assert.ok(part.specs.length);
  assert.equal(ui.confirmations.length, 0); assert.equal(ui.requests.filter(r => r.method === 'DELETE').length, 0);
  ui.button('Delete part'); ui.button('− Take');
});
