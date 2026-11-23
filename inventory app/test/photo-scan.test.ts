// Regression tests for the real Mouser bag photo: OCR garbles both part numbers, barcodes rescue them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabel } from '../src/shared/labels.ts';
import { MOUSER_PHOTO_BARCODES, MOUSER_PHOTO_LINES, MOUSER_PHOTO_OCR, MOUSER_PHOTO_OCR_RUN2 } from './fixtures/mouser-photo.ts';

test('bug repro: OCR alone no longer auto-fills junk part numbers; says unreadable', () => {
  for (const ocr of [MOUSER_PHOTO_OCR, MOUSER_PHOTO_OCR_RUN2]) {
    const f = parseLabel(ocr);
    assert.equal(f.supplier?.value, 'mouser');
    assert.equal(f.sku, undefined, `SKU must stay empty, got ${f.sku?.value}`);
    assert.equal(f.mpn, undefined, `MPN must stay empty, got ${f.mpn?.value}`);
    assert.equal(f.partNumberStatus, 'unreadable');
    assert.ok(f.guesses?.sku || f.guesses?.mpn, 'the unreliable OCR text is kept only as a hint');
  }
});

test('original photo: barcodes under the captions fill SKU, MPN and QTY', () => {
  for (const ocr of [MOUSER_PHOTO_OCR, MOUSER_PHOTO_OCR_RUN2]) {
    const f = parseLabel(ocr, MOUSER_PHOTO_BARCODES, undefined, MOUSER_PHOTO_LINES);
    assert.equal(f.sku?.value, '771-74LVC244APW-T');
    assert.equal(f.sku?.source, 'barcode');
    assert.equal(f.mpn?.value, '74LVC244APW,118');
    assert.equal(f.mpn?.source, 'barcode');
    assert.equal(f.quantity?.value, '12');
    assert.equal(f.manufacturer?.value, 'Nexperia');
    assert.equal(f.partNumberStatus, 'ok');
    assert.equal(f.guesses, undefined, 'barcode-verified fields leave no stale OCR hint');
    assert.deepEqual(f.unassigned?.sort(), ['015', '087258759', 'CN']);
  }
  const f = parseLabel(MOUSER_PHOTO_OCR_RUN2, MOUSER_PHOTO_BARCODES, undefined, MOUSER_PHOTO_LINES);
  assert.match(f.sku!.verifiedBy!, /Mouser P\/N/);
  assert.match(f.mpn!.verifiedBy!, /MFG P\/N/);
});

test('without OCR line boxes, SKU/MPN are still verified by content and position', () => {
  const f = parseLabel(MOUSER_PHOTO_OCR, MOUSER_PHOTO_BARCODES);
  assert.equal(f.sku?.value, '771-74LVC244APW-T');
  assert.match(f.sku!.verifiedBy!, /stem/);
  assert.equal(f.mpn?.value, '74LVC244APW,118');
  assert.equal(f.quantity?.value, '12');
});

test('a barcode that cannot be tied to a field is offered, not guessed', () => {
  // Only the MPN barcode decoded, no captions, and OCR is junk: no way to prove what it is.
  const f = parseLabel(MOUSER_PHOTO_OCR, [{ text: '74LVC244APW,118', x0: 261, y0: 917, x1: 715, y1: 966 }]);
  assert.equal(f.mpn, undefined);
  assert.deepEqual(f.unassigned, ['74LVC244APW,118']);
  assert.equal(f.partNumberStatus, 'unreadable');
  // With its caption line it is verified.
  const g = parseLabel(MOUSER_PHOTO_OCR, [{ text: '74LVC244APW,118', x0: 261, y0: 917, x1: 715, y1: 966 }], undefined, MOUSER_PHOTO_LINES);
  assert.equal(g.mpn?.value, '74LVC244APW,118');
  assert.equal(g.partNumberStatus, 'ok');
});

test('two different SKU-looking barcodes that both qualify are not guessed between', () => {
  const f = parseLabel('Mouser\nMouser P/N: x\nMouser P/N: y', [
    { text: '771-74LVC244APW-T' }, { text: '74LVC244APW,118' },
    { text: '595-SN74LVC244APWR' }, { text: 'SN74LVC244APWR' },
  ]);
  assert.equal(f.sku, undefined);
  assert.ok(f.unassigned?.includes('771-74LVC244APW-T'));
});

test('OCR SKU + MPN that agree are trusted; a plausible-looking but inconsistent OCR SKU is not', () => {
  const ok = parseLabel('MOUSER\nMouser P/N: 771-74LVC244APW-T\nMFG P/N: 74LVC244APW,118\nQTY: 12');
  assert.equal(ok.sku?.value, '771-74LVC244APW-T');
  assert.equal(ok.mpn?.value, '74LVC244APW,118');
  // Format-valid OCR SKU, but its stem disagrees with the (garbled) MFG P/N -> not trusted.
  const bad = parseLabel('MOUSER\nMouser P/N: 771-241YLR44APY-T\nMFG P/N: 74ycaqanpy,118\nQTY: 12');
  assert.equal(bad.sku, undefined);
  assert.equal(bad.guesses?.sku, '771-241YLR44APY-T');
});
