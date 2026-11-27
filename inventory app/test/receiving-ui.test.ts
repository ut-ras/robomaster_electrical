import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseLiveProductBarcode, parseLabel } from '../src/shared/labels.ts';
import { demo } from './helpers/demo.ts';
import { client } from './helpers/client.ts';
import { MOUSER_PHOTO_BARCODES, MOUSER_PHOTO_LINES, MOUSER_PHOTO_OCR } from './fixtures/mouser-photo.ts';

const scan = (fields: any, photoUrl?: string) => ({ fields, photoUrl, ocrText: '', barcodes: [], requestId: randomUUID() });

test('confident barcode auto-looks up, requires a count, receives, then next bag offers direct Add stock', async (t) => {
  const d = await demo(t); const ui = await client(d);
  const fields = parseLiveProductBarcode('771-74LVC244APW-T');
  await ui.renderReview(scan(fields));
  assert.ok(ui.view.textContent.includes('74LVC244APW,118'));
  assert.equal(ui.requests.filter(r => r.path === '/api/identify').length, 1);
  await ui.button('Save and add stock').click();
  assert.ok(ui.view.textContent.includes('Enter the counted quantity'));
  assert.equal((await d.store.read('parts')).length, 0);
  ui.input('Counted quantity').value = '12'; ui.input('Drawer (optional)').value = 'A3'; ui.input('Stock note (optional)').value = 'first bag';
  await ui.button('Save and add stock').click();
  assert.ok(ui.view.textContent.includes('Added 12 to drawer A3')); ui.button('Scan next');
  await ui.idle(); assert.ok(ui.view.textContent.includes('Added 12 to drawer A3'), 'confirmation remains visible');
  await ui.renderReview(scan(fields));
  assert.ok(ui.view.textContent.includes('A3: 12')); ui.input('Counted quantity').value = '2';
  const saves = ui.requests.filter(r => r.path === '/api/parts').length;
  await ui.button('Add stock').click();
  assert.equal(ui.requests.filter(r => r.path === '/api/parts').length, saves);
  assert.ok(ui.view.textContent.includes('Added 2 to drawer Not specified'));
  const part = (await d.inventory.loadAll())[0];
  assert.deepEqual(part.locations, [{ drawer: 'A3', qty: 12 }, { drawer: 'Not specified', qty: 2 }]);
});

test('photo read starts lookup automatically; printed count is only a suggestion; save-only leaves stock untouched', async (t) => {
  const d = await demo(t); const ui = await client(d);
  await ui.renderReview(scan(parseLabel(MOUSER_PHOTO_OCR, MOUSER_PHOTO_BARCODES, undefined, MOUSER_PHOTO_LINES), 'blob:photo'));
  assert.equal(ui.requests.filter(r => r.path === '/api/identify').length, 1);
  assert.ok(ui.view.textContent.includes('Printed quantity: 12'));
  assert.equal(ui.input('Counted quantity').value, '');
  await ui.button('Use 12').click(); assert.equal(ui.input('Counted quantity').value, '12');
  await ui.button('Save part only').click();
  assert.ok(ui.view.textContent.includes('No stock added'));
  assert.deepEqual((await d.inventory.loadAll())[0].locations, [{ drawer: 'Not specified', qty: null }]);
  assert.equal((await d.store.read('ledger')).length, 0);
});

test('manual part-number lookup reaches the same receiving screen; unclear result requires selection', async (t) => {
  const d = await demo(t); const ui = await client(d);
  await ui.renderReview(scan({})); assert.equal(ui.requests.length, 0);
  ui.input('Supplier').value = 'digikey'; ui.input('Supplier part number (SKU)').value = '495-75588-ND';
  await ui.button('Look up in catalog').click(); ui.button('Save and add stock');
  assert.ok(ui.view.textContent.includes('B32529C0564J000'));
  ui.input('Manufacturer part number').value = 'WRONG'; await ui.input('Manufacturer part number').dispatchEvent({ type: 'input' });
  assert.ok(!ui.all().some(el => el.textContent === 'Save and add stock'));
  await ui.button('Look up in catalog').click();
  assert.ok(ui.view.textContent.includes('Choose the exact part'));
  assert.ok(!ui.all().some(el => el.textContent === 'Save and add stock'));
  const radio = ui.all().find(el => el.attrs.type === 'radio')!;
  await radio.dispatchEvent({ type: 'change' }); ui.button('Save and add stock');
  ui.input('Counted quantity').value = '3'; await ui.button('Save and add stock').click();
  assert.equal((await d.store.read('ledger')).length, 1);
});

test('UI preserves inputs after partial failure and retries the same recorded stock operation', async (t) => {
  const d = await demo(t); let loseResponse = true;
  const ui = await client(d, async (path, body) => {
    if (path === '/api/stock' && loseResponse) { loseResponse = false; await d.request(path, body); throw new Error('response lost'); }
    return undefined;
  });
  await ui.renderReview(scan(parseLiveProductBarcode('771-74LVC244APW-T')));
  ui.input('Counted quantity').value = '8'; ui.input('Drawer (optional)').value = 'B2'; ui.input('Stock note (optional)').value = 'checked';
  await ui.button('Save and add stock').click();
  assert.ok(ui.view.textContent.includes('Part is saved. Stock addition could not be confirmed'));
  assert.equal(ui.input('Counted quantity').value, '8'); assert.equal(ui.input('Drawer (optional)').value, 'B2'); assert.equal(ui.input('Stock note (optional)').value, 'checked');
  await ui.button('Retry add stock').click();
  assert.ok(ui.view.textContent.includes('Added 8 to drawer B2')); assert.ok(ui.view.textContent.includes('no extra stock was added'));
  assert.equal(ui.requests.filter(r => r.path === '/api/parts').length, 1);
  const writes = ui.requests.filter(r => r.path === '/api/stock'); assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal((await d.store.read('ledger')).length, 1);
});

test('a late automatic lookup cannot replace a corrected part', async (t) => {
  const d = await demo(t);
  const stale = await d.request('/api/identify', { supplier: 'mouser', sku: d.part.sku });
  let release!: (response: Response) => void;
  const slow = new Promise<Response>(ok => { release = ok; });
  let first = true;
  const ui = await client(d, async path => { if (path === '/api/identify' && first) { first = false; return slow; } return undefined; });
  const opening = ui.renderReview(scan(parseLiveProductBarcode('771-74LVC244APW-T')));
  ui.input('Supplier').value = 'digikey'; ui.input('Supplier part number (SKU)').value = 'WM20054-ND';
  await ui.input('Supplier part number (SKU)').dispatchEvent({ type: 'input' });
  await ui.button('Look up in catalog').click();
  assert.ok(ui.view.textContent.includes('0387236506'));
  release(new Response(JSON.stringify(stale))); await opening;
  assert.ok(ui.view.textContent.includes('0387236506')); assert.ok(!ui.view.textContent.includes('74LVC244APW,118'));
});

test('Scan fallbacks, hardware and Search remain available', async (t) => {
  const d = await demo(t); const ui = await client(d);
  ui.renderScan(); for (const label of ['Scan barcode', 'Take photo', 'Upload photo', 'Enter part number', 'Add hardware']) ui.button(label);
  const files = ui.all().filter(el => el.attrs.type === 'file'); assert.equal(files.length, 2); assert.ok(files.some(el => el.attrs.capture === 'environment'));
  ui.renderSearch(); ui.input('Search inventory'); await ui.idle();
  await ui.renderReview(scan(parseLabel('McMaster-Carr\nPart Number: 31335A12\nDowel Pin')));
  assert.ok(ui.view.textContent.includes('McMaster-Carr')); ui.button('Save to inventory');
});
