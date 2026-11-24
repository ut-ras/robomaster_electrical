// Mechanical hardware: McMaster-Carr labels, manual hardware entry, optional drawers, and size search.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { parseLabel } from '../src/shared/labels.ts';
import { cleanHardwareSpecs, normDrawer, parseThreadSize, takeHardwareTerms, UNASSIGNED_DRAWER } from '../src/shared/hardware.ts';
import { parseLength } from '../src/shared/units.ts';
import { summarize } from '../src/shared/specs.ts';
import { search } from '../src/shared/query.ts';
import { FileStore } from '../src/server/store/file-store.ts';
import { Inventory, looseIdFor } from '../src/server/inventory.ts';
import { createApp } from '../src/server/app.ts';
import { authFromEnv } from '../src/server/auth.ts';
import { DemoDigikey, DemoMouser, identify } from '../src/server/catalog/index.ts';
import { MCMASTER_31335A12_READS, MCMASTER_5469K101_READS } from './fixtures/mcmaster-photos.ts';

const newInv = async () => { const store = new FileStore(); await store.ensureTabs(); return { store, inv: new Inventory(store) }; };
const ids = (parts: Awaited<ReturnType<Inventory['loadAll']>>, q: string) => search(parts, q).map((h) => h.part.partId).sort();

// ---------- McMaster labels (recorded OCR from the two attached photos) ----------

test('McMaster photo 1: 31335A12 locating pin; purchase order and line are not the part number', () => {
  const f = parseLabel(MCMASTER_31335A12_READS[0]);
  assert.equal(f.supplier?.value, 'mcmaster');
  assert.equal(f.sku?.value, '31335A12');
  assert.equal(f.partNumberStatus, 'ok');
  assert.equal(f.mcmaster?.purchaseOrder, '2650814');
  assert.equal(f.mcmaster?.line, '100');
  assert.notEqual(f.sku?.value, '2650814');
  assert.equal(f.description?.value, 'Mating Locating Pin, 5/16" Diameter Round');
  assert.equal(f.hardware?.category, 'pin');
  assert.deepEqual(f.hardware?.specs.find((s) => s.name === 'Diameter'), { name: 'Diameter', value: '5/16 in' });
  assert.equal(f.manufacturer?.value, 'McMaster-Carr');
});

test('McMaster photo 2 (372×297 px): reads disagree, so 5469K101 is offered as a guess, never a wrong auto-fill', () => {
  const [first, ...extra] = MCMASTER_5469K101_READS;
  // The first pass alone loses the K ("546910 1"): nothing is filled in.
  const one = parseLabel(first);
  assert.equal(one.supplier?.value, 'mcmaster');
  assert.equal(one.sku, undefined);
  assert.equal(one.partNumberStatus, 'unreadable');

  const all = parseLabel(first, [], undefined, [], extra);
  assert.equal(all.sku, undefined, 'only one of seven reads has the whole number, so it is not trusted');
  assert.equal(all.guesses?.sku, '5469K101', 'three reads say "5469K19+", but cut-off digits do not get a vote');
  assert.equal(all.mcmaster?.purchaseOrder, '31236');
  assert.equal(all.mcmaster?.line, '15');
  assert.equal(all.mcmaster?.ordered, '2');
  assert.equal(all.mcmaster?.shipped, '2');
  assert.match(all.description!.value, /^Anodized Aluminum Rectangular Manifold 2 Outlets/);
  assert.equal(all.hardware?.category, 'manifold');
  const spec = (n: string) => all.hardware!.specs.find((s) => s.name === n)?.value;
  assert.equal(spec('Pipe thread'), '1/4 NPT × 1/8 NPT');
  assert.equal(spec('Outlets'), '2');
  assert.equal(spec('Material'), 'Anodized Aluminum');
});

test('McMaster: clean reads that agree fill the part number; one clean read alone does too', () => {
  const label = (pn: string) => `McMASTER-CARR\nPurchase Order 31236\nLine 15\nPart Number ${pn}\nAnodized Aluminum Rectangular Manifold, 2\nOutlets on One Side, 1/4 NPT x 1/8 NPT\nOrdered 2 Each\nShipped 2 Each`;
  assert.equal(parseLabel(label('5469K101'), [], undefined, [], [label('5469K101'), label('5469K19+')]).sku?.value, '5469K101');
  assert.equal(parseLabel(label('5469K101')).sku?.value, '5469K101');
  const clean = parseLabel(label('5469K101'));
  assert.equal(clean.description?.value, 'Anodized Aluminum Rectangular Manifold, 2 Outlets on One Side, 1/4 NPT x 1/8 NPT');
  assert.equal(clean.quantity?.value, '2', 'label quantity is a hint for the count, not stock');
  // Mouser and DigiKey labels are not taken for McMaster.
  assert.equal(parseLabel('Mouser P/N: 771-74LVC244APW-T\nMFG P/N: 74LVC244APW,118').supplier?.value, 'mouser');
});

// ---------- sizes and threads ----------

test('metric and imperial threads stay distinct', () => {
  assert.deepEqual(parseThreadSize('M3'), { system: 'metric', size: 'M3', diameter: 0.003 });
  assert.equal(parseThreadSize('#4')?.system, 'imperial');
  assert.equal(parseThreadSize('1/4"')?.system, 'imperial');
  assert.equal(parseThreadSize('1/4'), undefined, 'a bare fraction is not assumed to be a thread size');
  assert.equal(parseThreadSize('1/4', 'imperial')?.size, '1/4"');
  assert.equal(parseThreadSize('M3', 'imperial'), undefined);
  assert.equal(parseThreadSize('#4', 'metric'), undefined);

  assert.match((cleanHardwareSpecs('screw', 'imperial', [{ name: 'Thread size', value: 'M3' }]) as any).error, /not an imperial thread size/);
  assert.match((cleanHardwareSpecs('screw', 'metric', [{ name: 'Thread size', value: '1/4"' }]) as any).error, /not a metric thread size/);
  assert.match((cleanHardwareSpecs('screw', 'imperial', [{ name: 'Thread pitch', value: '0.5' }]) as any).error, /threads per inch/);
  assert.match((cleanHardwareSpecs('screw', 'metric', [{ name: 'Threads per inch', value: '20' }]) as any).error, /pitch in mm/);
  const ok = cleanHardwareSpecs('screw', 'imperial', [{ name: 'Thread size', value: '1/4' }, { name: 'Threads per inch', value: '20' }, { name: 'Length', value: '3/4 in' }]);
  assert.deepEqual((ok as any).specs, [{ name: 'Thread system', value: 'Imperial (inch)' }, { name: 'Thread size', value: '1/4"' }, { name: 'Threads per inch', value: '20' }, { name: 'Length', value: '3/4 in' }]);
});

test('lengths: mm, fractions and mixed inches', () => {
  assert.equal(parseLength('8 mm'), 0.008);
  assert.ok(Math.abs(parseLength('5/16"')! - 0.0079375) < 1e-9);
  assert.ok(Math.abs(parseLength('1-1/2 in')! - 0.0381) < 1e-9);
  assert.ok(Math.abs(parseLength('1/2 in')! - 0.0127) < 1e-9, 'not 2 inches');
  assert.equal(parseLength('0.100" (2.54mm)'), 0.00254, 'connector pitch still prefers mm');
  const t = takeHardwareTerms('M3 x 8 mm');
  assert.deepEqual(t.constraints.map((c) => c.kind), ['thread', 'dim']);
});

test('drawer: blank, whitespace and "not specified" are one unassigned location', () => {
  for (const d of ['', '   ', undefined, 'not specified', ' Not  Specified ']) assert.equal(normDrawer(d), UNASSIGNED_DRAWER);
  assert.equal(normDrawer(' A3 '), 'A3');
});

// ---------- saving hardware ----------

test('McMaster pin with no drawer: one record and one unassigned location, stock only from confirmed counts', async () => {
  const { store, inv } = await newInv();
  const f = parseLabel(MCMASTER_31335A12_READS[0]);
  const save = (requestId: string, drawer = '') => inv.saveHardware({
    requestId, member: 'Ana', name: f.description!.value, category: f.hardware!.category, supplier: 'mcmaster', sku: f.sku!.value,
    description: f.description!.value, specs: f.hardware!.specs, specSource: 'McMaster-Carr label (photo)', drawer,
  });
  const a = await save('scan-1');
  const b = await save('scan-2', '   '); // a second scan of the same bag, drawer left blank
  assert.equal(a.partId, b.partId);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal((await store.read('parts')).length, 1);
  assert.deepEqual((await store.read('locations')).map((l) => l.drawer), [UNASSIGNED_DRAWER]);
  assert.equal((await store.read('ledger')).length, 0, 'saving never changes stock');
  const p = (await inv.getPart(a.partId))!;
  assert.equal(p.manufacturer, 'McMaster-Carr');
  assert.equal(p.mpn, '31335A12');
  assert.deepEqual(p.skus.map((s) => [s.supplier, s.sku]), [['mcmaster', '31335A12']]);
  assert.equal(summarize('pin', p.specs).find((s) => s.label === 'Diameter')!.value, '5/16 in');

  // stock with no drawer: add, remove, never negative
  const add = await inv.adjustStock({ requestId: 'c1', partId: a.partId, drawer: '', delta: 10, member: 'Ana', reason: 'receive' });
  assert.equal(add.balance, 10);
  const take = await inv.adjustStock({ requestId: 'c2', partId: a.partId, drawer: ' ', delta: -4, member: 'Ben', reason: 'remove' });
  assert.equal(take.balance, 6);
  await assert.rejects(inv.adjustStock({ requestId: 'c3', partId: a.partId, drawer: '', delta: -7, member: 'Ben', reason: 'remove' }), /Only 6 with no drawer/);
  assert.deepEqual((await store.read('ledger')).map((l) => l.drawer), [UNASSIGNED_DRAWER, UNASSIGNED_DRAWER]);
  assert.deepEqual((await inv.getPart(a.partId))!.locations, [{ drawer: UNASSIGNED_DRAWER, qty: 6 }]);
  assert.equal((await store.read('locations')).length, 1);
});

test('loose washer with no SKU and no drawer gets a stable HW- id; retries do not duplicate it', async () => {
  const { store, inv } = await newInv();
  const req = { member: 'Ana', name: 'M3 flat washer', category: 'washer' as const, specs: [
    { name: 'Inner diameter', value: '3.2 mm' }, { name: 'Outer diameter', value: '7 mm' }, { name: 'Thickness', value: '0.5 mm' },
    { name: 'For screw size', value: 'M3' }, { name: 'Material', value: '18-8 stainless steel' }] };
  const a = await inv.saveHardware({ ...req, requestId: 'w-1' });
  const retry = await inv.saveHardware({ ...req, requestId: 'w-1' });
  assert.match(a.partId, /^HW-[0-9A-F]{8}$/);
  assert.equal(a.partId, looseIdFor('w-1'));
  assert.equal(retry.partId, a.partId);
  assert.equal((await store.read('parts')).length, 1);
  assert.equal((await store.read('specs')).length, 5);
  assert.deepEqual((await store.read('locations')).map((l) => l.drawer), [UNASSIGNED_DRAWER]);
  // Adding more of the same: the member picks the existing part, so no second record.
  const more = await inv.saveHardware({ ...req, requestId: 'w-2', partId: a.partId, drawer: 'H4' });
  assert.equal(more.partId, a.partId);
  assert.equal((await store.read('parts')).length, 1);
  assert.deepEqual((await store.read('locations')).map((l) => l.drawer), [UNASSIGNED_DRAWER, 'H4']);
  const p = (await inv.getPart(a.partId))!;
  assert.deepEqual(summarize('washer', p.specs).map((s) => s.value), ['3.2 mm', '7 mm', '0.5 mm', '18-8 stainless steel']);
  await assert.rejects(inv.saveHardware({ ...req, requestId: 'w-3', name: '  ' }), /Part name is required/);
  await assert.rejects(inv.saveHardware({ ...req, requestId: 'w-4', category: 'capacitor' as any }), /hardware category/);
});

test('search: name, McMaster number, size, drawer; M3 x 8 mm is not M3 x 12 mm; metric is not imperial', async () => {
  const { inv } = await newInv();
  const screw = (requestId: string, name: string, system: 'metric' | 'imperial', specs: { name: string; value: string }[], drawer = '') =>
    inv.saveHardware({ requestId, member: 'Ana', name, category: 'screw', threadSystem: system, specs, drawer });
  const m3x8 = (await screw('s1', 'Socket head screw M3 x 8', 'metric', [{ name: 'Thread size', value: 'M3' }, { name: 'Thread pitch', value: '0.5' }, { name: 'Length', value: '8 mm' }, { name: 'Head style', value: 'Socket head' }], 'S1')).partId;
  const m3x12 = (await screw('s2', 'Socket head screw M3 x 12', 'metric', [{ name: 'Thread size', value: 'M3' }, { name: 'Thread pitch', value: '0.5' }, { name: 'Length', value: '12 mm' }], 'S1')).partId;
  const n4 = (await screw('s3', 'Pan head screw #4-40 x 1/2', 'imperial', [{ name: 'Thread size', value: '#4' }, { name: 'Threads per inch', value: '40' }, { name: 'Length', value: '1/2 in' }])).partId;
  const q14 = (await screw('s4', 'Hex screw 1/4-20 x 3/4', 'imperial', [{ name: 'Thread size', value: '1/4' }, { name: 'Threads per inch', value: '20' }, { name: 'Length', value: '3/4 in' }])).partId;
  const m6 = (await screw('s5', 'Screw M6 x 20', 'metric', [{ name: 'Thread size', value: 'M6' }, { name: 'Length', value: '20 mm' }])).partId;
  const f = parseLabel(MCMASTER_31335A12_READS[0]);
  const pin = (await inv.saveHardware({ requestId: 'p1', member: 'Ana', name: f.description!.value, category: 'pin', supplier: 'mcmaster', sku: '31335A12', specs: f.hardware!.specs, drawer: 'P2' })).partId;

  const all = await inv.loadAll();
  assert.deepEqual(ids(all, 'M3 x 8 mm'), [m3x8]);
  assert.deepEqual(ids(all, 'M3x8'), [m3x8]);
  assert.deepEqual(ids(all, 'M3 x 12 mm'), [m3x12]);
  assert.deepEqual(ids(all, 'M3-0.5 x 12mm'), [m3x12]);
  assert.deepEqual(ids(all, 'M3 screw'), [m3x8, m3x12].sort());
  assert.deepEqual(ids(all, 'M3 x 10 mm'), []);
  assert.deepEqual(ids(all, '#4-40'), [n4]);
  assert.deepEqual(ids(all, '#4-40 x 1/2"'), [n4]);
  assert.deepEqual(ids(all, '1/4-20 x 3/4'), [q14]);
  assert.deepEqual(ids(all, 'M6'), [m6], 'M6 does not match the 1/4" screw (6.35 mm)');
  assert.deepEqual(ids(all, '12 mm'), [m3x12]);
  assert.deepEqual(ids(all, '31335A12'), [pin]);
  assert.deepEqual(ids(all, 'locating pin'), [pin]);
  assert.deepEqual(ids(all, '5/16"'), [pin]);
  assert.deepEqual(ids(all, 'drawer P2'), [pin]);
  // Drawer names that look like metric sizes still find the drawer.
  const inM1 = (await inv.saveHardware({ requestId: 'd1', member: 'Ana', name: 'Spring pin', category: 'pin', drawer: 'M1' })).partId;
  const withM1 = await inv.loadAll();
  assert.deepEqual(ids(withM1, 'drawer M1'), [inM1]);
  assert.deepEqual(ids(withM1, 'M1'), [inM1]);
  assert.deepEqual(ids(withM1, 'drawer m1 pin'), [inM1]);
  assert.deepEqual(ids(all, 'drawer S1'), [m3x8, m3x12].sort());
  assert.deepEqual(ids(all, 'not specified'), [n4, q14, m6].sort());
  assert.deepEqual(ids(all, n4), [n4], 'the HW- id itself is searchable');
  assert.deepEqual(ids(all, 'socket head'), [m3x8, m3x12].sort());
});

test('electronics: drawer is optional too, and saving again without one reuses the location', async () => {
  const { store, inv } = await newInv();
  const providers = { mouser: new DemoMouser(), digikey: new DemoDigikey() };
  const r = await identify({ supplier: 'mouser', sku: '603-RT0603DRD071KL' }, providers);
  const a = await inv.save({ requestId: 'e1', member: 'Ana', drawer: '   ', part: r.chosen!, labelSku: { supplier: 'mouser', sku: '603-RT0603DRD071KL' } });
  await inv.save({ requestId: 'e2', member: 'Ben', drawer: '', part: r.chosen!, labelSku: { supplier: 'mouser', sku: '603-RT0603DRD071KL' } });
  assert.deepEqual((await store.read('locations')).map((l) => l.drawer), [UNASSIGNED_DRAWER]);
  await inv.adjustStock({ requestId: 'e3', partId: a.partId, drawer: '', delta: 25, member: 'Ana', reason: 'receive' });
  assert.deepEqual((await inv.getPart(a.partId))!.locations, [{ drawer: UNASSIGNED_DRAWER, qty: 25 }]);
});

// ---------- over HTTP, as the phone uses it ----------

test('HTTP: hardware save, no-drawer stock, add location, drawer list', async () => {
  const store = new FileStore();
  await store.ensureTabs();
  const server = createApp({ inventory: new Inventory(store), providers: { mouser: new DemoMouser(), digikey: new DemoDigikey() }, auth: authFromEnv({ TEAM_MEMBERS: 'Ana:0042', SESSION_SECRET: 'hw' }) });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { token } = await (await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'Ana', pin: '0042' }) })).json();
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    const [first, ...extra] = MCMASTER_5469K101_READS;
    const parsed = (await call('/api/parse', { text: first, altTexts: extra })).body;
    assert.equal(parsed.guesses.sku, '5469K101');
    // The member checks the photo, taps "Use 5469K101", leaves the drawer blank and saves.
    const saved = await call('/api/hardware', { requestId: 'm-1', name: parsed.description.value, category: parsed.hardware.category, supplier: 'mcmaster', sku: parsed.guesses.sku, specs: parsed.hardware.specs, drawer: ' ' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.part.locations, [{ drawer: UNASSIGNED_DRAWER, qty: null }]);
    assert.equal(saved.body.part.summary.find((s: any) => s.label === 'Pipe thread').value, '1/4 NPT × 1/8 NPT');
    const id = saved.body.partId;
    // counted 2 in the bag (label: ordered 2, shipped 2)
    assert.equal((await call('/api/stock', { requestId: 'k-1', partId: id, drawer: '', delta: 2 })).body.balance, 2);
    assert.equal((await call(`/api/parts/${id}/locations`, { requestId: 'loc-1', drawer: 'M1' })).body.added, true);
    assert.equal((await call(`/api/parts/${id}/locations`, { requestId: 'loc-2', drawer: '' })).body.added, false, 'one unassigned location per part');
    assert.deepEqual((await call('/api/drawers')).body, ['M1'], '"Not specified" is not offered as a drawer');
    const hits = (await call('/api/search?q=5469K101')).body.hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].part.category, 'manifold');
    const loose = await call('/api/hardware', { requestId: 'm-2', name: 'Washer', category: 'washer', specs: [] });
    assert.match(loose.body.partId, /^HW-/);
    assert.equal((await call(`/api/parts/${loose.body.partId}`)).status, 200);
    assert.equal((await call('/api/hardware', { requestId: 'm-3', name: 'x', category: 'screw', threadSystem: 'imperial', specs: [{ name: 'Thread size', value: 'M3' }] })).status, 400);
    assert.equal((await call('/api/hardware', { requestId: 'm-4', name: 'x', category: 'pin', sku: '31335A12' })).status, 400, 'a part number needs its supplier');
    const noAuth = await fetch(`${base}/api/hardware`, { method: 'POST', body: '{}' });
    assert.equal(noAuth.status, 401);
  } finally {
    server.close();
  }
});
