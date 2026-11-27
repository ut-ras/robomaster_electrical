import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceipt, type ReceiptDraft } from '../src/client/receiving.ts';
import { demo } from './helpers/demo.ts';

test('new bag saves and receives in one action; same operation and next bag have distinct effects', async (t) => {
  const d = await demo(t);
  const draft: ReceiptDraft = { part: d.part, count: '12', drawer: ' A3 ', note: ' counted by Alex ' };
  const first = createReceipt(d.request, 'save-bag-1', 'stock-bag-1');
  const a = first.submit(draft, true);
  assert.equal(first.submit(draft, true), a, 'double tap shares the pending operation');
  const r = await a;
  assert.equal(r.drawer, 'A3'); assert.equal(r.balance, 12);
  await first.submit({ ...draft, count: '99' }, true);
  const identified = await d.request('/api/identify', { supplier: 'mouser', sku: d.part.sku });
  assert.deepEqual(identified.chosen.existing.locations, [{ drawer: 'A3', qty: 12 }]);
  assert.equal(identified.existing.partId, r.partId);
  const calls: string[] = [];
  const second = createReceipt(async (path, body) => { calls.push(path); return d.request(path, body); }, 'save-bag-2', 'stock-bag-2', r.partId);
  await second.submit({ ...draft, count: '3', note: 'second bag' }, true);
  assert.deepEqual(calls, ['/api/stock'], 'existing part is not saved again');
  const p = await d.request(`/api/parts/${r.partId}`);
  assert.equal(p.locations[0].qty, 15); assert.equal(p.history.length, 2);
  assert.equal(p.history[0].note, 'counted by Alex'); assert.equal(p.history[1].note, 'second bag');
});

test('blank drawer becomes Not specified; save-only never creates a stock ledger row', async (t) => {
  const d = await demo(t);
  const draft = { part: d.part, count: '', drawer: '  ', note: '' };
  const saved = await createReceipt(d.request, 'save-only', 'unused-stock').submit(draft, false);
  let p = await d.request(`/api/parts/${saved.partId}`);
  assert.deepEqual(p.locations, [{ drawer: 'Not specified', qty: null }]); assert.equal(p.history.length, 0);
  await createReceipt(d.request, 'unused-save', 'receive-no-drawer', saved.partId).submit({ ...draft, count: '2' }, true);
  p = await d.request(`/api/parts/${saved.partId}`);
  assert.deepEqual(p.locations, [{ drawer: 'Not specified', qty: 2 }]);
});

test('save succeeds and stock fails: retry retains count, drawer, note and ids without re-saving', async (t) => {
  const d = await demo(t);
  let fail = true;
  const calls: { path: string; body: any }[] = [];
  const receipt = createReceipt(async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/stock' && fail) { fail = false; throw new Error('offline'); }
    return d.request(path, body);
  }, 'save-partial', 'stock-partial');
  const draft = { part: d.part, count: '7', drawer: 'A3', note: 'open bag' };
  await assert.rejects(receipt.submit(draft, true), /offline/);
  assert.ok(receipt.partId);
  assert.equal((await d.inventory.history(receipt.partId!)).length, 0);
  const r = await receipt.submit({ ...draft, count: '999', drawer: 'B9', note: 'changed' }, true);
  assert.equal(r.balance, 7); assert.equal(r.drawer, 'A3');
  assert.equal(calls.filter(c => c.path === '/api/parts').length, 1);
  assert.deepEqual(calls[1], calls[2]);
  assert.equal((await d.inventory.history(r.partId))[0].note, 'open bag');
});

test('lost save and stock responses retry the same operations without duplicating inventory or stock', async (t) => {
  const d = await demo(t);
  const lost = new Set(['/api/parts', '/api/stock']);
  const receipt = createReceipt(async (path, body) => {
    const result = await d.request(path, body);
    if (lost.delete(path)) throw new Error('response lost');
    return result;
  }, 'lost-save', 'lost-stock');
  const draft = { part: d.part, count: '5', drawer: '', note: 'sealed' };
  await assert.rejects(receipt.submit(draft, true), /response lost/);
  await assert.rejects(receipt.submit(draft, true), /response lost/);
  const r = await receipt.submit(draft, true);
  assert.equal(r.duplicate, true); assert.equal(r.balance, 5);
  assert.equal((await d.store.read('parts')).length, 1);
  assert.equal((await d.store.read('locations')).length, 1);
  assert.equal((await d.store.read('ledger')).length, 1);
});

test('count must be explicitly supplied and valid; validation allows correction before any write', async (t) => {
  const d = await demo(t);
  let writes = 0;
  const receipt = createReceipt(async (path, body) => { writes++; return d.request(path, body); }, 'valid-save', 'valid-stock');
  for (const count of ['', ' ', '0', '-1', '1.5', 'NaN', '1e2', '9007199254740992']) {
    assert.throws(() => receipt.submit({ part: d.part, count, drawer: '', note: '' }, true), /counted quantity/);
  }
  assert.equal(receipt.started, false); assert.equal(writes, 0);
  await receipt.submit({ part: d.part, count: '1', drawer: '', note: '' }, true);
  assert.equal(writes, 2);
});

test('existing identity is found for MPN-only and cross-supplier lookup, never a conflicting candidate', async (t) => {
  const d = await demo(t);
  const saved = await createReceipt(d.request, 'identity-save', 'identity-stock').submit({ part: d.part, count: '4', drawer: 'A3', note: '' }, true);
  // The bundled DigiKey fixtures do not list this Nexperia part; supply a deliberate demo twin.
  d.providers.digikey.lookup = async pn => pn === d.part.mpn ? [{ ...d.part, supplier: 'digikey', sku: 'TEST-NEXPERIA-ND', altSkus: [] }] : [];
  for (const supplier of ['mouser', 'digikey']) {
    const r = await d.request('/api/identify', { supplier, mpn: d.part.mpn });
    assert.equal(r.chosen.existing.partId, saved.partId);
  }
  const original = d.providers.mouser.lookup.bind(d.providers.mouser);
  d.providers.mouser.lookup = async pn => pn === 'ambiguous' ? [d.part, { ...d.part, sku: '595-OTHER', mpn: 'DIFFERENT' }] : original(pn);
  const ambiguous = await d.request('/api/identify', { supplier: 'mouser', sku: 'ambiguous' });
  assert.equal(ambiguous.status, 'review'); assert.equal(ambiguous.existing, undefined);
  assert.equal(ambiguous.candidates[0].part.existing.partId, saved.partId);
  assert.equal(ambiguous.candidates[1].part.existing, undefined);
  d.providers.mouser.lookup = async () => [{ ...d.part, mpn: 'OTHER-MPN' }];
  const conflict = await d.request('/api/identify', { supplier: 'mouser', sku: d.part.sku });
  assert.equal(conflict.chosen.existing, undefined, 'a known SKU cannot direct stock to a different MPN');
});
