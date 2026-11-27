import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveProductBarcode } from '../src/shared/labels.ts';

test('live scan recognizes standalone Mouser and DigiKey supplier SKUs', () => {
  for (const [raw, supplier] of [['771-74LVC244APW-T', 'mouser'], ['WM20054-ND', 'digikey']] as const) {
    const fields = parseLiveProductBarcode(raw);
    assert.equal(fields?.supplier?.value, supplier);
    assert.equal(fields?.sku?.value, raw);
    assert.equal(fields?.sku?.source, 'barcode');
    assert.equal(fields?.partNumberStatus, 'ok');
  }
});

test('live scan preserves a leading zero and the printed quantity in a structured code', () => {
  const fields = parseLiveProductBarcode('[)>\x1e06\x1dPWM20054-ND\x1d1P0387236506\x1dQ2\x1e\x04');
  assert.equal(fields?.supplier?.value, 'digikey');
  assert.equal(fields?.sku?.value, 'WM20054-ND');
  assert.equal(fields?.mpn?.value, '0387236506');
  assert.equal(fields?.quantity?.value, '2');
});

test('live scan supports part-number-only 2D codes when the member selects the supplier', () => {
  const raw = '[)>{RS}06{GS}1P74LVC244APW,118{GS}Q12{RS}';
  assert.equal(parseLiveProductBarcode(raw), undefined);
  const fields = parseLiveProductBarcode(raw, 'mouser');
  assert.equal(fields?.supplier?.value, 'mouser');
  assert.equal(fields?.mpn?.value, '74LVC244APW,118');
});

test('live scan ignores typical non-product codes and supplier mismatches', () => {
  for (const raw of ['12', '079020754', 'PUR2139580', 'https://example.com/', '[)>{RS}06{GS}Q32{RS}']) {
    assert.equal(parseLiveProductBarcode(raw, 'mouser'), undefined);
  }
  assert.equal(parseLiveProductBarcode('771-74LVC244APW-T', 'digikey'), undefined);
  assert.equal(parseLiveProductBarcode('WM20054-ND', 'mouser'), undefined);
});
