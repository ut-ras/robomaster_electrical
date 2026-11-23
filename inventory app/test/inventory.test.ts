import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoDigikey, DemoMouser, identify, manufacturerKey } from '../src/server/catalog/index.ts';
import { DIGIKEY_FIXTURES, MOUSER_FIXTURES } from '../src/server/catalog/fixtures.ts';
import { FileStore } from '../src/server/store/file-store.ts';
import { Inventory } from '../src/server/inventory.ts';
import { search } from '../src/shared/query.ts';
import type { MouserApiPart } from '../src/server/catalog/mouser.ts';
import type { DigikeyApiProduct } from '../src/server/catalog/digikey.ts';

const demo = () => ({ mouser: new DemoMouser(), digikey: new DemoDigikey() });

// SYNTHETIC parts (fake SKUs) used only to exercise cross-supplier rules.
const SYN_MOUSER: MouserApiPart = {
  MouserPartNumber: '999-SYN-RES-10K', ManufacturerPartNumber: 'SYN-0603-10K-1%', Manufacturer: 'Yageo',
  Description: 'Thick Film Resistors 10K 1% 0.1W', Category: 'Thick Film Resistors - SMD',
  ProductAttributes: [{ AttributeName: 'Resistance', AttributeValue: '10 kOhms' }, { AttributeName: 'Tolerance', AttributeValue: '1 %' }],
};
const SYN_DK: DigikeyApiProduct = {
  ManufacturerProductNumber: 'SYN-0603-10K-1%', Manufacturer: { Name: 'YAGEO' }, Description: { ProductDescription: 'RES 10K OHM 1% 1/10W 0603' },
  Category: { Name: 'Resistors', ChildCategories: [{ Name: 'Chip Resistor - Surface Mount' }] },
  Parameters: [{ ParameterText: 'Resistance', ValueText: '10 kOhms' }, { ParameterText: 'Tolerance', ValueText: '±1%' }, { ParameterText: 'Power (Watts)', ValueText: '0.1W, 1/10W' }, { ParameterText: 'Temperature Coefficient', ValueText: '±100ppm/°C' }],
  ProductVariations: [{ DigiKeyProductNumber: 'SYN-10K-1-ND' }],
  DatasheetUrl: 'https://example.invalid/syn.pdf',
};
// Same electrical ratings, different manufacturer part number -> must stay a separate record.
const SYN_DK_TWIN: DigikeyApiProduct = { ...SYN_DK, ManufacturerProductNumber: 'SYN-0603-10K-1%-ALT', ProductVariations: [{ DigiKeyProductNumber: 'SYN-10K-ALT-ND' }] };

const synProviders = () => ({ mouser: new DemoMouser([...MOUSER_FIXTURES, SYN_MOUSER]), digikey: new DemoDigikey([...DIGIKEY_FIXTURES, SYN_DK, SYN_DK_TWIN]) });

test('manufacturer names normalise across catalogs and labels', () => {
  assert.equal(manufacturerKey('EPCOS - TDK Electronics'), manufacturerKey('TDK ELECTRONICS INC'));
  assert.equal(manufacturerKey('Nexperia USA Inc.'), manufacturerKey('Nexperia'));
  assert.equal(manufacturerKey('Murata Electronics'), 'murata');
  assert.notEqual(manufacturerKey('Molex'), manufacturerKey('TDK'));
});

test('Mouser acceptance part identifies exactly with comma suffix', async () => {
  const r = await identify({ supplier: 'mouser', sku: '771-74LVC244APW-T', mpn: '74LVC244APW,118', manufacturer: 'Nexperia' }, demo());
  assert.equal(r.status, 'matched');
  assert.equal(r.chosen!.mpn, '74LVC244APW,118');
  assert.equal(r.gapFill?.supplier, 'digikey');
  assert.equal(r.gapFill?.rejected, 'not listed'); // demo DigiKey has no record, so nothing is borrowed
});

test('DigiKey photo part identifies (TDK label vs EPCOS catalog name)', async () => {
  const r = await identify({ supplier: 'digikey', sku: '495-75588-ND', mpn: 'B32529C0564J000', manufacturer: 'TDK ELECTRONICS INC' }, demo());
  assert.equal(r.status, 'matched');
  assert.ok(r.chosen!.specs.some((s) => s.key === 'voltage_rated' && s.num === 63));
});

test('DigiKey demo row keeps leading zero; missing specs are just unknown', async () => {
  const r = await identify({ supplier: 'digikey', sku: 'WM20054-ND', mpn: '0387236506', manufacturer: 'Molex' }, demo());
  assert.equal(r.status, 'matched');
  assert.equal(r.chosen!.mpn, '0387236506');
});

test('label/catalog disagreement goes to review', async () => {
  const r = await identify({ supplier: 'mouser', sku: '771-74LVC244APW-T', mpn: '74LVC244APW,112', manufacturer: 'Nexperia' }, demo());
  assert.equal(r.status, 'review');
  assert.ok(r.reasons.some((x) => x.includes('differs')));
  assert.equal(r.chosen, undefined);
});

test('gap fill only from an exact manufacturer + MPN match', async () => {
  const r = await identify({ supplier: 'mouser', sku: '999-SYN-RES-10K' }, synProviders());
  assert.equal(r.status, 'matched');
  assert.deepEqual(r.crossSku, { supplier: 'digikey', sku: 'SYN-10K-1-ND' });
  assert.ok(r.gapFill!.addedKeys.includes('power'));
  assert.equal(r.chosen!.datasheetUrl, 'https://example.invalid/syn.pdf');
  assert.ok(!r.chosen!.specs.some((s) => s.source === 'digikey' && s.key === 'resistance'), 'specs Mouser already had are not duplicated');
});

async function saveFromIdentify(inv: Inventory, providers: any, supplier: 'mouser' | 'digikey', sku: string, drawer: string, requestId: string, member = 'Ana') {
  const r = await identify({ supplier, sku }, providers);
  assert.ok(r.chosen, `no chosen part for ${sku}`);
  return inv.save({ requestId, member, drawer, part: r.chosen!, labelSku: { supplier, sku }, crossSku: r.crossSku });
}

test('same component from both suppliers -> one record, both SKUs find it with all drawers', async () => {
  const inv = new Inventory(new FileStore());
  const prov = synProviders();
  const a = await saveFromIdentify(inv, prov, 'mouser', '999-SYN-RES-10K', 'B1', 'r1');
  const b = await saveFromIdentify(inv, prov, 'digikey', 'SYN-10K-1-ND', 'B2', 'r2');
  assert.equal(a.partId, b.partId);
  const all = await inv.loadAll();
  assert.equal(all.length, 1);
  for (const q of ['999-SYN-RES-10K', 'SYN-10K-1-ND']) {
    const hits = search(all, q);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].part.locations.map((l) => l.drawer).sort(), ['B1', 'B2']);
  }
  assert.equal(all[0].skus.find((s) => s.sku === 'SYN-10K-1-ND')!.onLabel, true, 'catalog-linked SKU upgraded once bought');
});

test('parts that only share ratings stay separate', async () => {
  const inv = new Inventory(new FileStore());
  const prov = synProviders();
  const a = await saveFromIdentify(inv, prov, 'digikey', 'SYN-10K-1-ND', 'B1', 'r1');
  const b = await saveFromIdentify(inv, prov, 'digikey', 'SYN-10K-ALT-ND', 'B1', 'r2');
  assert.notEqual(a.partId, b.partId);
  assert.equal((await inv.loadAll()).length, 2);
});

test('retried save is idempotent; part numbers are stored as exact text', async () => {
  const store = new FileStore();
  const inv = new Inventory(store);
  await saveFromIdentify(inv, demo(), 'mouser', '771-74LVC244APW-T', 'A1', 'same');
  await saveFromIdentify(inv, demo(), 'mouser', '771-74LVC244APW-T', 'A1', 'same');
  await saveFromIdentify(inv, demo(), 'digikey', 'WM20054-ND', 'C4', 'x');
  await saveFromIdentify(inv, demo(), 'digikey', 'WM20054-ND', 'C4', 'x');
  const parts = await store.read('parts');
  assert.equal(parts.length, 2);
  assert.equal((await store.read('skus')).length, 2);
  assert.equal((await store.read('locations')).length, 2);
  const specsBefore = (await store.read('specs')).length;
  await saveFromIdentify(inv, demo(), 'mouser', '771-74LVC244APW-T', 'A1', 'again');
  assert.equal((await store.read('specs')).length, specsBefore);
  assert.deepEqual(parts.map((p) => p.mpn).sort(), ['0387236506', '74LVC244APW,118']);
  const all = await inv.loadAll();
  assert.equal(search(all, '0387236506')[0].part.locations[0].drawer, 'C4');
  assert.equal(search(all, '74LVC244APW,118')[0].part.locations[0].drawer, 'A1');
  assert.equal(search(all, '387236506').length, 1, 'substring search still works');
});

test('SKU already linked to a different part is refused', async () => {
  const inv = new Inventory(new FileStore());
  await saveFromIdentify(inv, demo(), 'mouser', '771-74LVC244APW-T', 'A1', 'r1');
  const r = await identify({ supplier: 'digikey', sku: 'WM20054-ND' }, demo());
  await assert.rejects(inv.save({ requestId: 'r2', member: 'Ana', drawer: 'A2', part: r.chosen!, labelSku: { supplier: 'mouser', sku: '771-74LVC244APW-T' } }), /already linked/);
});

test('verified manual edits survive a catalog refresh', async () => {
  const inv = new Inventory(new FileStore());
  const { partId } = await saveFromIdentify(inv, demo(), 'digikey', '495-75588-ND', 'D1', 'r1');
  await inv.editSpec(partId, 'ESR', '25mOhm @ 100kHz', 'https://example.invalid/datasheet.pdf#page=4', 'Ben');
  // Catalog now (say) reports a different tolerance string for the same attribute; and a manual row exists.
  const fresh = (await new DemoDigikey().lookup('495-75588-ND'))[0];
  fresh.specs = fresh.specs.map((s) => (s.name === 'Tolerance' ? { ...s, value: '±10%' } : s));
  await inv.refreshSpecs(partId, fresh, 'Ana');
  const p = (await inv.getPart(partId))!;
  assert.equal(p.specs.find((s) => s.name === 'Tolerance' && s.source === 'digikey')!.value, '±10%', 'unverified catalog rows refresh');
  const esr = p.specs.find((s) => s.name === 'ESR')!;
  assert.equal(esr.verified, true);
  assert.equal(esr.condition, '@ 100kHz');
  await assert.rejects(Promise.resolve().then(() => inv.editSpec(partId, 'ESR', '1', '', 'Ben')), /source/);
});

test('stock: duplicate submissions, concurrent removals, never negative', async () => {
  const inv = new Inventory(new FileStore());
  const { partId } = await saveFromIdentify(inv, demo(), 'mouser', '771-74LVC244APW-T', 'A1', 's');
  assert.equal((await inv.loadAll())[0].locations[0].qty, null, 'saving a scan does not create stock');
  const add = await inv.adjustStock({ requestId: 'add-1', partId, drawer: 'A1', delta: 5, member: 'Ana', reason: 'receive' });
  const dup = await inv.adjustStock({ requestId: 'add-1', partId, drawer: 'A1', delta: 5, member: 'Ana', reason: 'receive' });
  assert.equal(add.balance, 5);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.balance, 5);
  const results = await Promise.allSettled([
    inv.adjustStock({ requestId: 'rm-a', partId, drawer: 'A1', delta: -3, member: 'Ana', reason: 'remove' }),
    inv.adjustStock({ requestId: 'rm-b', partId, drawer: 'a1', delta: -3, member: 'Ben', reason: 'remove' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message), /Only 2/);
  const hist = await inv.history(partId);
  assert.equal(hist.length, 2);
  assert.ok(hist.every((h) => h.member && h.timestamp && h.drawer === 'A1'));
  assert.equal((await inv.loadAll())[0].locations[0].qty, 2);
});
