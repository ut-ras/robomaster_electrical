// Map catalog attribute names onto canonical keys, parse their values, and build category summaries.

import type { Category, Spec, SpecSource } from './types.ts';
import { formatSI, parseCondition, parseLength, parseQuantities, parseRange, parseTolerance } from './units.ts';

/** Ordered: the first matching pattern wins, so specific patterns come before generic ones. */
const KEY_PATTERNS: [RegExp, string][] = [
  [/^capacitance$/i, 'capacitance'],
  [/^resistance$/i, 'resistance'],
  [/^inductance$/i, 'inductance'],
  [/^tolerance$/i, 'tolerance'],
  [/voltage.*(rating|rated).*ac|ac.*voltage/i, 'voltage_rated_ac'],
  [/^(voltage - rated|voltage rating( - dc| dc)?|rated voltage|voltage rating|dc voltage rating|working voltage)$/i, 'voltage_rated'],
  [/supply voltage - min|operating supply voltage - min|^vcc min/i, 'supply_voltage_min'],
  [/supply voltage - max|operating supply voltage - max|^vcc max/i, 'supply_voltage_max'],
  [/^(voltage - supply|supply voltage|operating supply voltage|supply voltage range)$/i, 'supply_voltage'],
  [/^(temperature coefficient|tempco)$/i, 'tempco'],
  [/dielectric|temperature characteristic/i, 'dielectric'],
  [/^esr|equivalent series resistance/i, 'esr'],
  [/^(power( \(watts\))?|power rating|power - max|rated power)$/i, 'power'],
  [/saturation/i, 'current_sat'],
  [/^(current rating( \(amps\))?|rated current|current - max|current rating|maximum dc current|current - rated)$/i, 'current_rating'],
  [/^(dc resistance( \(dcr\))?|dcr|dc resistance \(dcr\) \(max\))$/i, 'dcr'],
  [/^(logic type|function|product type|type)$/i, 'function'],
  [/number of channels|^channels$|number of elements|number of circuits/i, 'channels'],
  [/bits per element/i, 'bits_per_element'],
  [/number of pins|pin count|number of terminals|^pins$/i, 'pin_count'],
  [/number of positions|^positions$|number of contacts|number of positions loaded/i, 'positions'],
  [/^pitch|pitch - mating|lead spacing/i, 'pitch'],
  [/contact material/i, 'contact_material'],
  [/contact finish( - mating)?$|^finish$|contact plating/i, 'contact_finish'],
  [/^(package \/ case|package\/case|package|case code - in|case code \(imperial\)|supplier device package)$/i, 'package'],
  [/operating temperature/i, 'operating_temp'],
  [/^mounting( type| style)$/i, 'mounting'],
];

/** Name suffix for specs read out of a catalog's free-text description rather than its structured attributes. */
export const FROM_DESCRIPTION = ' (from description)';
const FROM_DESCRIPTION_RE = /\s*\(from description\)$/i;

export function isFromDescription(s: Pick<Spec, 'name'>): boolean {
  return FROM_DESCRIPTION_RE.test(s.name);
}

export function canonicalKey(name: string): string | undefined {
  const n = name.trim().replace(FROM_DESCRIPTION_RE, '');
  for (const [re, key] of KEY_PATTERNS) if (re.test(n)) return key;
  return undefined;
}

const KEY_UNIT: Record<string, string> = {
  capacitance: 'F', resistance: 'Ω', inductance: 'H', voltage_rated: 'V', voltage_rated_ac: 'V',
  supply_voltage: 'V', supply_voltage_min: 'V', supply_voltage_max: 'V', esr: 'Ω', dcr: 'Ω',
  power: 'W', current_rating: 'A', current_sat: 'A',
};

const INTEGER_KEYS = new Set(['channels', 'pin_count', 'positions', 'bits_per_element']);

/** Build a Spec from a raw name/value pair, keeping the original strings and adding parsed fields. */
export function makeSpec(name: string, value: string, source: SpecSource, extra: Partial<Spec> = {}): Spec {
  const spec: Spec = { name, value, source, ...extra };
  const key = canonicalKey(name);
  if (key) spec.key = key;
  const v = value.trim();
  if (!v || /^(-|—|n\/?a|unknown)$/i.test(v)) return spec;

  if (key === 'tolerance') {
    const tol = parseTolerance(v);
    if (tol) { spec.tol = tol; spec.unit = tol.kind === 'percent' ? '%' : tol.unit; }
  } else if (key && INTEGER_KEYS.has(key)) {
    const m = /(\d+)/.exec(v);
    if (m) spec.num = parseInt(m[1], 10);
  } else if (key === 'tempco') {
    const m = /(\d+(?:\.\d+)?|\.\d+)\s*ppm/i.exec(v);
    if (m) { spec.num = parseFloat(m[1]); spec.unit = 'ppm/°C'; }
  } else if (key === 'pitch') {
    const len = parseLength(v);
    if (len !== undefined) { spec.num = len; spec.unit = 'm'; }
  } else if (key === 'operating_temp') {
    const r = parseRange(v);
    if (r) { spec.min = r.min; spec.max = r.max; spec.unit = '°C'; }
  } else {
    const range = parseRange(v);
    const want = key ? KEY_UNIT[key] : undefined;
    if (range && (!want || range.unit === want)) {
      spec.min = range.min; spec.max = range.max; spec.unit = range.unit;
    } else {
      const qs = parseQuantities(v).filter((q) => !want || q.unit === want);
      if (qs.length) { spec.num = qs[0].value; spec.unit = qs[0].unit; }
    }
    // tolerances can also appear inline, e.g. "100 nF ±10%"
    if (/±|%/.test(v) && !spec.tol && key !== 'tolerance') {
      const tol = parseTolerance(v.replace(/^[^±+-]*?(?=[±+-]\s*\d)/, ''));
      if (tol && tol.kind === 'absolute') spec.tol = tol;
    }
  }
  const cond = parseCondition(v);
  if (cond) spec.condition = cond;
  return spec;
}

// ---------- specs printed only in the catalog description ----------

const NUM_RE = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const NOT_AFTER = String.raw`(?<![\w.\/])`; // not the tail of another number, word or fraction
const OHM_RE = new RegExp(String.raw`${NOT_AFTER}${NUM_RE}\s*([kKMGm]?)\s*(?:[oO][hH][mM][sS]?|Ω)(?![a-zA-Z])`, 'g');
const FRACTION_W_RE = new RegExp(String.raw`${NOT_AFTER}(\d+)\s*\/\s*(\d+)\s*W(?![a-zA-Z])`, 'g');
const DECIMAL_W_RE = new RegExp(String.raw`${NOT_AFTER}${NUM_RE}\s*(m?)W(?![a-zA-Z])`, 'g');
const PERCENT_RE = new RegExp(String.raw`(?<![\w.])(?:±|\+\/-)?\s*${NUM_RE}\s*%`, 'g');
const PPM_RE = new RegExp(String.raw`(?<![\w.])(±|\+\/-)?\s*${NUM_RE}\s*ppm(?:\s*\/\s*°?\s*[CK])?(?![a-zA-Z])`, 'gi');
const OHM_PREFIX: Record<string, number> = { '': 1, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** The single value a pattern found, or undefined when it found none or several different ones (ambiguous). */
function onlyValue(values: number[]): number | undefined {
  const distinct = [...new Set(values.map((v) => Number(v.toPrecision(9))))];
  return distinct.length === 1 && Number.isFinite(distinct[0]) ? distinct[0] : undefined;
}

/**
 * Resistor specs that a catalog prints only in its description, e.g. Mouser's
 * "Thin Film Resistors - SMD 1/10W 1K ohm .5% 25ppm" -> 1 kΩ, ±0.5%, 0.1 W, 25 ppm/°C.
 * Only for resistors, only values that appear exactly once, and only keys not in `skipKeys`
 * (the structured attributes already present). The spec name ends in " (from description)" and
 * sourceRef records the description itself, so the Specs tab shows where each value came from.
 */
export function specsFromDescription(description: string, category: string, source: 'mouser' | 'digikey', skipKeys: Set<string> = new Set()): Spec[] {
  const d = (description ?? '').trim();
  if (!d || detectCategory(category, d) !== 'resistor') return [];
  const sourceRef = `${source === 'mouser' ? 'Mouser' : 'DigiKey'} description: ${d}`;
  const out: Spec[] = [];
  const add = (key: string, label: string, value: string) => {
    if (!skipKeys.has(key)) out.push(makeSpec(label + FROM_DESCRIPTION, value, source, { sourceRef }));
  };

  const ohms = onlyValue([...d.matchAll(OHM_RE)].map((m) => parseFloat(m[1]) * OHM_PREFIX[m[2]]));
  if (ohms !== undefined && ohms > 0) add('resistance', 'Resistance', formatSI(ohms, 'Ω'));

  const tol = onlyValue([...d.matchAll(PERCENT_RE)].map((m) => parseFloat(m[1])));
  if (tol !== undefined && tol > 0) add('tolerance', 'Tolerance', `±${tol}%`);

  const watts = onlyValue([
    ...[...d.matchAll(FRACTION_W_RE)].map((m) => Number(m[1]) / Number(m[2])),
    ...[...d.matchAll(DECIMAL_W_RE)].map((m) => parseFloat(m[1]) * (m[2] === 'm' ? 1e-3 : 1)),
  ]);
  if (watts !== undefined && watts > 0) add('power', 'Power', `${Number(watts.toPrecision(4))} W`);

  const ppmHits = [...d.matchAll(PPM_RE)];
  const ppm = onlyValue(ppmHits.map((m) => parseFloat(m[2])));
  if (ppm !== undefined && ppm > 0) add('tempco', 'Temperature Coefficient', `${ppmHits[0][1] ? '±' : ''}${ppm} ppm/°C`);

  return out;
}

export function detectCategory(category: string, description: string): Category {
  const s = `${category} ${description}`.toLowerCase();
  if (/capacitor|\bcap\b|\bcap\s|mlcc/.test(s)) return 'capacitor';
  if (/resistor|\bres\b|\bres\s/.test(s)) return 'resistor';
  if (/inductor|\bind\b|choke|ferrite/.test(s)) return 'inductor';
  if (/connector|header|jumper|terminal|housing|receptacle|\bconn\b|socket|crimp/.test(s)) return 'connector';
  if (/\bic\b|buffer|driver|logic|amplifier|regulator|microcontroller|mcu|transceiver|interface|converter|gate|flip|register|sensor|op ?amp/.test(s)) return 'ic';
  return 'other';
}

interface SummaryRow { label: string; keys: string[] }

const SUMMARY: Record<Category, SummaryRow[]> = {
  capacitor: [
    { label: 'Capacitance', keys: ['capacitance'] },
    { label: 'Tolerance', keys: ['tolerance'] },
    { label: 'Rated voltage', keys: ['voltage_rated'] },
    { label: 'Dielectric', keys: ['dielectric'] },
    { label: 'Package', keys: ['package'] },
    { label: 'ESR', keys: ['esr'] },
  ],
  resistor: [
    { label: 'Resistance', keys: ['resistance'] },
    { label: 'Tolerance', keys: ['tolerance'] },
    { label: 'Power rating', keys: ['power'] },
    { label: 'Temp. coefficient', keys: ['tempco'] },
  ],
  inductor: [
    { label: 'Inductance', keys: ['inductance'] },
    { label: 'Tolerance', keys: ['tolerance'] },
    { label: 'Current rating', keys: ['current_rating'] },
    { label: 'Saturation current', keys: ['current_sat'] },
    { label: 'DC resistance', keys: ['dcr'] },
  ],
  ic: [
    { label: 'Function', keys: ['function'] },
    { label: 'Supply voltage', keys: ['supply_voltage', 'supply_voltage_min', 'supply_voltage_max'] },
    { label: 'Channels', keys: ['channels'] },
    { label: 'Pin count', keys: ['pin_count'] },
    { label: 'Package', keys: ['package'] },
  ],
  connector: [
    { label: 'Positions', keys: ['positions'] },
    { label: 'Pitch', keys: ['pitch'] },
    { label: 'Contact material', keys: ['contact_material'] },
    { label: 'Contact finish', keys: ['contact_finish'] },
  ],
  other: [
    { label: 'Package', keys: ['package'] },
  ],
};

/** Verified manual specs first, then structured catalog attributes, then values read from a description, then the bag label. */
function specRank(s: Spec): number {
  if (s.verified) return 0;
  if (s.source === 'label') return 3;
  return isFromDescription(s) ? 2 : 1;
}

/** The best spec for this key by specRank; ties keep catalog order. */
export function pickSpec(specs: Spec[], key: string): Spec | undefined {
  let best: Spec | undefined;
  for (const s of specs) if (s.key === key && (!best || specRank(s) < specRank(best))) best = s;
  return best;
}

/** Source label for summaries: "mouser description" for values read from the description. */
export function sourceLabel(s: Spec): string {
  return isFromDescription(s) ? `${s.source} description` : s.source;
}

export interface SummaryItem { label: string; value: string; known: boolean; sources: string[] }

export function summarize(category: Category, specs: Spec[]): SummaryItem[] {
  return SUMMARY[category].map((row) => {
    if (row.label === 'Supply voltage') {
      const range = pickSpec(specs, 'supply_voltage');
      if (range) return { label: row.label, value: range.value, known: true, sources: [sourceLabel(range)] };
      const lo = pickSpec(specs, 'supply_voltage_min');
      const hi = pickSpec(specs, 'supply_voltage_max');
      if (lo || hi) {
        const fmt = (s?: Spec) => (s?.num !== undefined ? formatSI(s.num, 'V') : s?.value ?? 'unknown');
        return { label: row.label, value: `${fmt(lo)} – ${fmt(hi)}`, known: !!(lo && hi), sources: [lo, hi].filter((x): x is Spec => !!x).map(sourceLabel) };
      }
      return { label: row.label, value: 'unknown', known: false, sources: [] };
    }
    const s = pickSpec(specs, row.keys[0]);
    if (!s) return { label: row.label, value: 'unknown', known: false, sources: [] };
    return { label: row.label, value: s.condition && !s.value.includes(s.condition) ? `${s.value} (${s.condition})` : s.value, known: true, sources: [sourceLabel(s)] };
  });
}

/** Keys the summary wants for this category, used to decide whether to ask the second catalog. */
export function summaryKeys(category: Category): string[] {
  const keys = SUMMARY[category].flatMap((r) => r.keys);
  return category === 'ic' ? keys.filter((k) => k !== 'supply_voltage_min' && k !== 'supply_voltage_max') : keys;
}

export function hasKey(specs: Spec[], key: string): boolean {
  if (key === 'supply_voltage') return specs.some((s) => s.key === 'supply_voltage' || s.key === 'supply_voltage_min' || s.key === 'supply_voltage_max');
  return specs.some((s) => s.key === key);
}
