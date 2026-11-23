// Regression: YAGEO RT0603DRD071KL (Mouser 603-RT0603DRD071KL). The live Mouser lookup returns only Packaging and
// Standard Pack Qty as attributes, so resistance, tolerance, power and tempco showed as "unknown". They are printed in
// the description, and are now read from it, ranked below structured catalog values and verified manual edits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoDigikey, DemoMouser, identify } from '../src/server/catalog/index.ts';
import { normalizeMouser, type MouserApiPart } from '../src/server/catalog/mouser.ts';
import type { DigikeyApiProduct } from '../src/server/catalog/digikey.ts';
import { FileStore } from '../src/server/store/file-store.ts';
import { Inventory } from '../src/server/inventory.ts';
import { detectCategory, specsFromDescription, summarize } from '../src/shared/specs.ts';
import { search } from '../src/shared/query.ts';

const DESCRIPTION = 'Thin Film Resistors - SMD 1/10W 1K ohm .5% 25ppm';
const SKU = '603-RT0603DRD071KL';

// As the live Mouser lookup returned it: ratings only in the description, Packaging repeated once per option.
const LIVE_SHAPED: MouserApiPart = {
  MouserPartNumber: SKU,
  ManufacturerPartNumber: 'RT0603DRD071KL',
  Manufacturer: 'YAGEO',
  Description: DESCRIPTION,
  Category: 'Thin Film Resistors - SMD',
  ProductDetailUrl: `https://www.mouser.com/ProductDetail/${SKU}`,
  ProductAttributes: [
    { AttributeName: 'Packaging', AttributeValue: 'Reel' },
    { AttributeName: 'Packaging', AttributeValue: 'Cut Tape' },
    { AttributeName: 'Packaging', AttributeValue: 'MouseReel' },
    { AttributeName: 'Standard Pack Qty', AttributeValue: '5000' },
  ],
};

const providers = (mouser: MouserApiPart[] = [LIVE_SHAPED], digikey: DigikeyApiProduct[] = []) =>
  ({ mouser: new DemoMouser(mouser), digikey: new DemoDigikey(digikey) });

const summaryOf = (specs: Parameters<typeof summarize>[1]) =>
  Object.fromEntries(summarize('resistor', specs).map((s) => [s.label, s.value]));

test('YAGEO 603-RT0603DRD071KL: resistor specs come from the Mouser description', () => {
  const part = normalizeMouser(LIVE_SHAPED, 'live');
  assert.equal(detectCategory(part.category, part.description), 'resistor');
  assert.deepEqual(summaryOf(part.specs), {
    Resistance: '1 kΩ', Tolerance: '±0.5%', 'Power rating': '0.1 W', 'Temp. coefficient': '25 ppm/°C',
  });
  const derived = part.specs.filter((s) => s.name.endsWith('(from description)'));
  assert.equal(derived.length, 4);
  for (const s of derived) {
    assert.equal(s.source, 'mouser');
    assert.equal(s.sourceRef, `Mouser description: ${DESCRIPTION}`);
    assert.ok(!s.verified);
  }
  const by = (k: string) => derived.find((s) => s.key === k)!;
  assert.equal(by('resistance').num, 1000);
  assert.deepEqual(by('tolerance').tol, { kind: 'percent', minus: 0.5, plus: 0.5 });
  assert.equal(by('power').num, 0.1);
  assert.equal(by('tempco').num, 25);
  assert.equal(by('tempco').unit, 'ppm/°C');
  const all = summarize('resistor', part.specs);
  assert.ok(all.every((s) => s.known && s.sources[0] === 'mouser description'));
});

test('description values are only taken when clear', () => {
  // Two different percentages: tolerance is ambiguous, so it is left unknown. The rest still parse.
  const keys = specsFromDescription('Thick Film Resistors - SMD 1/4W 10K ohm 1% 5% 100ppm', 'Thick Film Resistors - SMD', 'mouser').map((s) => s.key);
  assert.deepEqual(keys.sort(), ['power', 'resistance', 'tempco']);
  // Same power printed twice in two forms is not ambiguous.
  const pw = specsFromDescription('Thick Film Resistors 0.1W 1/10W 47 Ohms 1%', 'Resistors', 'mouser').find((s) => s.key === 'power');
  assert.equal(pw?.value, '0.1 W');
  // Not a resistor: nothing is read from the description.
  assert.deepEqual(specsFromDescription('Multilayer Ceramic Capacitors MLCC - SMD/SMT 50V 0.1uF X7R 0805 5%', 'MLCC', 'mouser'), []);
});

test('structured catalog values outrank the description', async () => {
  // Mouser's own attribute for a key suppresses the description value for that key.
  const withAttr = normalizeMouser({ ...LIVE_SHAPED, ProductAttributes: [...LIVE_SHAPED.ProductAttributes!, { AttributeName: 'Tolerance', AttributeValue: '1 %' }] }, 'live');
  assert.equal(withAttr.specs.filter((s) => s.key === 'tolerance').length, 1);
  assert.equal(summaryOf(withAttr.specs).Tolerance, '1 %');

  // An exact manufacturer + MPN DigiKey record still gap-fills, and its structured values win.
  const dk: DigikeyApiProduct = {
    ManufacturerProductNumber: 'RT0603DRD071KL', Manufacturer: { Name: 'YAGEO' },
    Description: { ProductDescription: 'RES 1K OHM 0.5% 1/10W 0603' },
    Category: { Name: 'Resistors', ChildCategories: [{ Name: 'Chip Resistor - Surface Mount' }] },
    Parameters: [{ ParameterText: 'Resistance', ValueText: '1 kOhms' }, { ParameterText: 'Temperature Coefficient', ValueText: '±25ppm/°C' }],
    ProductVariations: [{ DigiKeyProductNumber: 'SYN-RT0603-1K-ND' }],
  };
  const r = await identify({ supplier: 'mouser', sku: SKU }, providers([LIVE_SHAPED], [dk]));
  assert.equal(r.status, 'matched');
  assert.ok(r.gapFill!.addedKeys.includes('resistance') && r.gapFill!.addedKeys.includes('tempco'));
  const s = summarize('resistor', r.chosen!.specs);
  assert.deepEqual(s.map((x) => `${x.label}=${x.value}<${x.sources[0]}>`), [
    'Resistance=1 kOhms<digikey>', 'Tolerance=±0.5%<mouser description>', 'Power rating=0.1 W<mouser description>', 'Temp. coefficient=±25ppm/°C<digikey>',
  ]);
});

test('saved to the Specs tab, searchable, and re-saving updates specs without duplicating the part or stock', async () => {
  const store = new FileStore();
  await store.ensureTabs();
  const inv = new Inventory(store);

  // Before the fix: the part was saved with only Packaging / Standard Pack Qty, and stock was counted in.
  const old = normalizeMouser(LIVE_SHAPED, 'live');
  old.specs = old.specs.filter((s) => !s.name.endsWith('(from description)'));
  const first = await inv.save({ requestId: 'r1', member: 'Ana', drawer: 'R2', part: old, labelSku: { supplier: 'mouser', sku: SKU } });
  await inv.adjustStock({ requestId: 's1', partId: first.partId, drawer: 'R2', delta: 50, member: 'Ana', reason: 'receive' });
  assert.equal(summaryOf((await inv.getPart(first.partId))!.specs).Resistance, 'unknown');

  // Refresh: look it up again and save to the same drawer (twice, to show it is idempotent).
  for (const rid of ['r2', 'r3']) {
    const r = await identify({ supplier: 'mouser', sku: SKU }, providers());
    const again = await inv.save({ requestId: rid, member: 'Ben', drawer: 'r2 ', part: r.chosen!, labelSku: { supplier: 'mouser', sku: SKU }, crossSku: r.crossSku });
    assert.equal(again.partId, first.partId);
    assert.equal(again.created, false);
  }
  // The "Refresh catalog specs" path is also a no-op now.
  await inv.refreshSpecs(first.partId, normalizeMouser(LIVE_SHAPED, 'live'), 'Ben');

  assert.equal((await store.read('parts')).length, 1);
  assert.equal((await store.read('skus')).length, 1);
  assert.equal((await store.read('locations')).length, 1);
  assert.equal((await store.read('ledger')).length, 1);
  const rows = (await store.read('specs')).filter((x) => x.part_id === first.partId);
  assert.equal(rows.length, 6, 'packaging, pack qty and four description specs, no duplicates');
  assert.equal(rows.find((x) => x.name === 'Packaging')!.value, 'Reel, Cut Tape, MouseReel', 'repeated Mouser attribute is one row');
  const row = (k: string) => rows.find((x) => x.key === k)!;
  assert.deepEqual([row('resistance').value, row('tolerance').value, row('power').value, row('tempco').value], ['1 kΩ', '±0.5%', '0.1 W', '25 ppm/°C']);
  assert.equal(row('resistance').num, '1000');
  assert.equal(row('tolerance').tol_minus, '0.5');
  for (const k of ['resistance', 'tolerance', 'power', 'tempco']) {
    assert.equal(row(k).source, 'mouser');
    assert.equal(row(k).source_ref, `Mouser description: ${DESCRIPTION}`);
    assert.equal(row(k).verified, 'FALSE');
  }

  const p = (await inv.getPart(first.partId))!;
  assert.deepEqual(summaryOf(p.specs), { Resistance: '1 kΩ', Tolerance: '±0.5%', 'Power rating': '0.1 W', 'Temp. coefficient': '25 ppm/°C' });
  assert.deepEqual(p.locations, [{ drawer: 'R2', qty: 50 }]);

  const all = await inv.loadAll();
  const ids = (q: string) => search(all, q).map((h) => h.part.partId);
  for (const q of ['1 kΩ resistor', '1k ohm', '±0.5% or tighter', 'resistor at least 0.1 W', '1/10W', '25 ppm', 'RT0603DRD071KL', SKU]) {
    assert.deepEqual(ids(q), [first.partId], q);
  }
  for (const q of ['10 kΩ', '±0.1% or tighter', 'at least 0.25 W']) assert.deepEqual(ids(q), [], q);

  // A verified manual edit outranks the description and survives another refresh + save.
  await inv.editSpec(first.partId, 'Tolerance', '±1%', 'datasheet p.2', 'Ana');
  const r = await identify({ supplier: 'mouser', sku: SKU }, providers());
  await inv.save({ requestId: 'r4', member: 'Ben', drawer: 'R2', part: r.chosen!, labelSku: { supplier: 'mouser', sku: SKU } });
  const after = (await inv.getPart(first.partId))!;
  const tol = summarize('resistor', after.specs).find((s) => s.label === 'Tolerance')!;
  assert.equal(tol.value, '±1%');
  assert.equal(tol.sources[0], 'manual');
  assert.equal((await store.read('ledger')).length, 1);
});
