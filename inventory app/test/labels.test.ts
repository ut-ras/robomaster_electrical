import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabel, parseEcia } from '../src/shared/labels.ts';
import {
  MOUSER_74LVC244_OCR, MOUSER_74LVC244_OCR_NOISY, MOUSER_74LVC244_BARCODES,
  DIGIKEY_TDK_OCR, DIGIKEY_MOLEX_OCR, DIGIKEY_MOLEX_DATAMATRIX,
} from './fixtures/labels.ts';

test('Mouser acceptance label: SKU, MPN with comma+suffix, manufacturer, qty', () => {
  const f = parseLabel(MOUSER_74LVC244_OCR);
  assert.equal(f.supplier?.value, 'mouser');
  assert.equal(f.sku?.value, '771-74LVC244APW-T');
  assert.equal(f.mpn?.value, '74LVC244APW,118');
  assert.equal(f.manufacturer?.value, 'Nexperia');
  assert.equal(f.quantity?.value, '12');
  assert.match(f.description!.value, /BUFFERS/);
});

test('Mouser noisy OCR is corrected by the printed Code 128 barcodes', () => {
  const ocrOnly = parseLabel(MOUSER_74LVC244_OCR_NOISY);
  assert.equal(ocrOnly.sku?.value, '771-74LVC244APW-T', 'digit prefix l->1 fix');
  assert.equal(ocrOnly.mpn?.value, '74LVC244APW.118', 'OCR alone cannot know . vs ,');
  const withBarcodes = parseLabel(MOUSER_74LVC244_OCR_NOISY, MOUSER_74LVC244_BARCODES);
  assert.equal(withBarcodes.mpn?.value, '74LVC244APW,118');
  assert.equal(withBarcodes.mpn?.source, 'barcode');
  assert.equal(withBarcodes.quantity?.value, '12');
});

test('DigiKey photo label (TDK film cap)', () => {
  const f = parseLabel(DIGIKEY_TDK_OCR);
  assert.equal(f.supplier?.value, 'digikey');
  assert.equal(f.sku?.value, '495-75588-ND');
  assert.equal(f.mpn?.value, 'B32529C0564J000');
  assert.equal(f.manufacturer?.value, 'TDK ELECTRONICS INC');
  assert.equal(f.quantity?.value, '10');
  assert.equal(f.description?.value, 'CAP FILM 0.56UF 5% 63VDC RADIAL');
});

test('DigiKey demo label keeps the Molex leading zero', () => {
  const f = parseLabel(DIGIKEY_MOLEX_OCR);
  assert.equal(f.sku?.value, 'WM20054-ND');
  assert.equal(f.mpn?.value, '0387236506');
  assert.equal(f.quantity?.value, '2');
  assert.equal(f.manufacturer?.value, 'Molex');
});

test('ECIA DataMatrix gives exact fields and overrides OCR', () => {
  assert.deepEqual(parseEcia(DIGIKEY_MOLEX_DATAMATRIX), { p: 'WM20054-ND', mpn: '0387236506', qty: '2' });
  const f = parseLabel('PN WM2OO54-ND\n387236506\nDigiKey', [DIGIKEY_MOLEX_DATAMATRIX]);
  assert.equal(f.sku?.value, 'WM20054-ND');
  assert.equal(f.mpn?.value, '0387236506');
  assert.equal(f.quantity?.value, '2');
});

test('user can override detected supplier', () => {
  const f = parseLabel(DIGIKEY_MOLEX_OCR, [], 'mouser');
  assert.equal(f.supplier?.value, 'mouser');
  assert.equal(f.supplier?.reason, 'chosen by user');
});
