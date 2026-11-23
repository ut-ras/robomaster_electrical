import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantity, parseTolerance, parseRange, formatSI } from '../src/shared/units.ts';
import { makeSpec, summarize } from '../src/shared/specs.ts';
import { parseQuery, search } from '../src/shared/query.ts';
import type { InventoryPart, Spec } from '../src/shared/types.ts';

test('100 nF == 0.1 µF == 0.1uF == 100000 pF', () => {
  const a = parseQuantity('100 nF')!.value;
  for (const s of ['0.1 µF', '0.1uF', '0.1μF', '100000pF', '.1uF']) {
    assert.ok(Math.abs(parseQuantity(s)!.value - a) < 1e-15, s);
  }
  assert.equal(formatSI(1e-7, 'F'), '100 nF');
});

test('tolerance forms are preserved', () => {
  assert.deepEqual(parseTolerance('±10%'), { kind: 'percent', minus: 10, plus: 10 });
  assert.deepEqual(parseTolerance('-20%, +80%'), { kind: 'percent', minus: 20, plus: 80 });
  assert.deepEqual(parseTolerance('−20%/+80%'), { kind: 'percent', minus: 20, plus: 80 });
  assert.deepEqual(parseTolerance('+80%, -20%'), { kind: 'percent', minus: 20, plus: 80 });
  const abs = parseTolerance('±0.1pF')!;
  assert.equal(abs.kind, 'absolute');
  assert.ok(Math.abs(abs.minus - 1e-13) < 1e-20);
  assert.equal(parseTolerance('-'), undefined);
  assert.deepEqual(parseTolerance('5 %'), { kind: 'percent', minus: 5, plus: 5 });
});

test('ranges, min/max ratings and test conditions', () => {
  assert.deepEqual(parseRange('1.2V ~ 3.6V'), { min: 1.2, max: 3.6, unit: 'V' });
  assert.deepEqual(parseRange('1.65 V to 5.5 V'), { min: 1.65, max: 5.5, unit: 'V' });
  const esr = makeSpec('ESR (Equivalent Series Resistance)', '100mOhm @ 100kHz', 'digikey');
  assert.equal(esr.key, 'esr');
  assert.ok(Math.abs(esr.num! - 0.1) < 1e-12);
  assert.equal(esr.condition, '@ 100kHz');
  const pwr = makeSpec('Power (Watts)', '0.25W, 1/4W', 'digikey');
  assert.equal(pwr.num, 0.25);
  const supply = makeSpec('Voltage - Supply', '1.2V ~ 3.6V', 'digikey');
  assert.equal(supply.min, 1.2);
  assert.equal(supply.max, 3.6);
  const mouserV = makeSpec('Voltage Rating DC', '63 VDC', 'mouser');
  assert.equal(mouserV.key, 'voltage_rated');
  assert.equal(mouserV.num, 63);
});

function cap(id: string, specs: [string, string][]): InventoryPart {
  return {
    partId: id, manufacturer: 'Test', mpn: id, category: 'capacitor', description: 'test cap',
    skus: [], locations: [{ drawer: 'T1', qty: null }],
    specs: specs.map(([n, v]) => makeSpec(n, v, 'manual')),
  };
}

const parts: InventoryPart[] = [
  cap('CAP-50V-5PCT', [['Capacitance', '0.1 µF'], ['Voltage - Rated', '50V'], ['Tolerance', '±5%']]),
  cap('CAP-16V-10PCT', [['Capacitance', '100nF'], ['Voltage - Rated', '16V'], ['Tolerance', '±10%']]),
  cap('CAP-50V-20PCT', [['Capacitance', '100nF'], ['Voltage - Rated', '50V'], ['Tolerance', '±20%']]),
  cap('CAP-50V-UNKNOWN', [['Capacitance', '100nF'], ['Voltage - Rated', '50V']]),
  cap('CAP-50V-ASYM', [['Capacitance', '100nF'], ['Voltage - Rated', '50V'], ['Tolerance', '-20%, +80%']]),
  cap('CAP-1UF-25V-10', [['Capacitance', '1µF'], ['Voltage - Rated', '25V'], ['Tolerance', '±10%']]),
  cap('CAP-25V-10-EXACT', [['Capacitance', '100000pF'], ['Voltage - Rated', '25V'], ['Tolerance', '10%']]),
  { ...cap('RES-100K', [['Resistance', '100 kOhms'], ['Tolerance', '±1%']]), category: 'resistor' },
];

test('acceptance: "100 nF capacitor, at least 25 V, ±10% or tighter"', () => {
  const q = parseQuery('100 nF capacitor, at least 25 V, ±10% or tighter');
  assert.equal(q.category, 'capacitor');
  assert.equal(q.constraints.length, 3);
  assert.deepEqual(q.terms, []);
  const ids = search(parts, '100 nF capacitor, at least 25 V, ±10% or tighter').map((h) => h.part.partId).sort();
  assert.deepEqual(ids, ['CAP-25V-10-EXACT', 'CAP-50V-5PCT']);
});

test('0.1 µF query is equivalent to 100 nF', () => {
  const a = search(parts, '100 nF capacitor, at least 25 V, ±10% or tighter').map((h) => h.part.partId).sort();
  const b = search(parts, '0.1uF cap >= 25V 10%').map((h) => h.part.partId).sort();
  assert.deepEqual(a, b);
});

test('absolute tolerance query', () => {
  const small: InventoryPart[] = [
    cap('C0G-10PF-ABS', [['Capacitance', '10pF'], ['Tolerance', '±0.1pF'], ['Voltage - Rated', '50V']]),
    cap('C0G-10PF-PCT', [['Capacitance', '10pF'], ['Tolerance', '±5%'], ['Voltage - Rated', '50V']]),
  ];
  assert.deepEqual(search(small, '10 pF ±0.1 pF or tighter').map((h) => h.part.partId), ['C0G-10PF-ABS']);
  assert.deepEqual(search(small, '10 pF ±0.5 pF').map((h) => h.part.partId).sort(), ['C0G-10PF-ABS', 'C0G-10PF-PCT']);
});

test('summary marks missing specs unknown', () => {
  const specs: Spec[] = [makeSpec('Capacitance', '0.56 µF', 'digikey')];
  const s = summarize('capacitor', specs);
  assert.equal(s.find((x) => x.label === 'Capacitance')!.value, '0.56 µF');
  assert.equal(s.find((x) => x.label === 'ESR')!.value, 'unknown');
});

test('search by drawer and description text', () => {
  assert.equal(search(parts, 'drawer T1').length, parts.length);
  assert.deepEqual(search(parts, '100 kOhm resistor').map((h) => h.part.partId), ['RES-100K']);
});
