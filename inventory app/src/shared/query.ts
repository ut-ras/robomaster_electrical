// Inventory search: free text (SKUs, MPNs, description, drawer) plus parametric constraints such as
// "100 nF capacitor, at least 25 V, ±10% or tighter". Unknown specs never satisfy a constraint.

import type { Category, InventoryPart, Spec } from './types.ts';
import { pickSpec } from './specs.ts';
import { approxEqual, normText, worstTolerancePct } from './units.ts';

export interface ValueConstraint { kind: 'value'; unit: string; op: 'eq' | 'ge' | 'le'; value: number; text: string }
export interface TolConstraint { kind: 'tol'; maxPct?: number; maxAbs?: number; unit?: string; text: string }
export type Constraint = ValueConstraint | TolConstraint;

export interface ParsedQuery { constraints: Constraint[]; category?: Category; terms: string[] }

const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6 };
const UNIT_CANON: Record<string, string> = { F: 'F', 'Ω': 'Ω', R: 'Ω', H: 'H', V: 'V', VDC: 'V', A: 'A', W: 'W' };

const CATEGORY_WORDS: [RegExp, Category][] = [
  [/^(capacitors?|caps?)$/i, 'capacitor'],
  [/^(resistors?|res)$/i, 'resistor'],
  [/^(inductors?|chokes?)$/i, 'inductor'],
  [/^(connectors?|headers?|jumpers?|terminals?)$/i, 'connector'],
  [/^(ics?|chips?)$/i, 'ic'],
];

const STOP = new Set(['or', 'and', 'at', 'least', 'most', 'tighter', 'better', 'than', 'with', 'a', 'an', 'the', 'of', 'min', 'minimum', 'max', 'maximum', 'tolerance', 'tol', 'rated', 'rating', 'more', 'less', 'higher', 'lower', 'up', 'to', 'over', 'under', 'in', 'for']);

const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const PFX = String.raw`(p|n|u|µ|μ|m|k|K|M)?`;
const UNIT = String.raw`(F|Ω|H|VDC|V|A|W)`;

export function parseQuery(input: string): ParsedQuery {
  // "1/10W" -> "0.1 W" so fractional power ratings parse like decimal ones.
  let q = normText(input).replace(/(?<![\w.\/])(\d+)\s*\/\s*(\d+)\s*W(?![a-zA-Z])/g, (_, a, b) => `${Number(a) / Number(b)} W`);
  const constraints: Constraint[] = [];
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(q))) { fn(m); q = q.slice(0, m.index) + ' ' + q.slice(m.index + m[0].length); re.lastIndex = 0; }
  };

  // Tolerances first so "10%" is not mistaken for anything else.
  take(new RegExp(String.raw`±\s*${NUM}\s*${PFX}\s*(F|Ω|H)(?:\s+or\s+(?:tighter|better|less))?`), (m) => {
    constraints.push({ kind: 'tol', maxAbs: parseFloat(m[1]) * PREFIX[m[2] ?? ''], unit: m[3] === 'R' ? 'Ω' : m[3], text: m[0].trim() });
  });
  take(new RegExp(String.raw`(?:(?:tolerance|tol)\s*(?:<=|≤|of|at most|under)?\s*)?±?\s*${NUM}\s*%(?:\s+(?:or\s+(?:tighter|better|less)|tolerance|tol))*`, 'i'), (m) => {
    constraints.push({ kind: 'tol', maxPct: parseFloat(m[1]), text: m[0].trim() });
  });

  const valueRe = (pre: string, post: string) => new RegExp(String.raw`${pre}${NUM}\s*${PFX}\s*${UNIT}(?![a-zA-Z])${post}`, 'i');
  const push = (m: RegExpExecArray, op: ValueConstraint['op']) => {
    const unit = UNIT_CANON[m[3]] ?? m[3];
    // "M" before Ω means mega but "m" before V/A/W/F/H means milli; keep case-sensitive prefix lookup
    constraints.push({ kind: 'value', unit, op, value: parseFloat(m[1]) * PREFIX[m[2] ?? ''], text: m[0].trim() });
  };
  // NB: PFX must stay case-sensitive, so these regexes use the case-sensitive prefix group via explicit flags below.
  const ci = (re: RegExp) => new RegExp(re.source, ''); // case-sensitive
  take(ci(valueRe(String.raw`(?:at\s+least|minimum|min\.?|>=|≥|over|above)\s*`, '')), (m) => push(m, 'ge'));
  take(ci(valueRe(String.raw`(?:at\s+most|maximum|max\.?|<=|≤|under|below|up\s+to)\s*`, '')), (m) => push(m, 'le'));
  take(ci(valueRe('', String.raw`\s*(?:\+|or\s+(?:more|higher|above)|min(?:imum)?\b)`)), (m) => push(m, 'ge'));
  take(ci(valueRe('', String.raw`\s*(?:or\s+(?:less|lower|below)|max(?:imum)?\b)`)), (m) => push(m, 'le'));
  take(ci(valueRe(String.raw`(?<![\w.\-])`, '')), (m) => {
    const unit = UNIT_CANON[m[3]] ?? m[3];
    // Bare ratings (V, A, W) mean "at least this rating"; bare F/Ω/H mean "this nominal value".
    push(m, unit === 'V' || unit === 'A' || unit === 'W' ? 'ge' : 'eq');
  });

  let category: Category | undefined;
  const terms: string[] = [];
  for (const raw of q.split(/\s+/)) {
    const t = raw.replace(/^[,;:]+|[,;:.]+$/g, '');
    if (!t) continue;
    const cat = CATEGORY_WORDS.find(([re]) => re.test(t));
    if (cat && !category) { category = cat[1]; continue; }
    if (STOP.has(t.toLowerCase())) continue;
    terms.push(t);
  }
  return { constraints, category, terms };
}

function specFor(part: InventoryPart, unit: string): Spec | undefined {
  switch (unit) {
    case 'F': return pickSpec(part.specs, 'capacitance');
    case 'Ω': return pickSpec(part.specs, 'resistance');
    case 'H': return pickSpec(part.specs, 'inductance');
    case 'W': return pickSpec(part.specs, 'power');
    case 'A': return pickSpec(part.specs, 'current_rating');
    case 'V': return pickSpec(part.specs, 'voltage_rated') ?? pickSpec(part.specs, 'supply_voltage');
  }
  return undefined;
}

function nominal(part: InventoryPart): number | undefined {
  for (const k of ['capacitance', 'resistance', 'inductance']) {
    const s = pickSpec(part.specs, k);
    if (s?.num !== undefined) return s.num;
  }
  return undefined;
}

export interface ConstraintResult { constraint: Constraint; ok: boolean; why: string }

export function checkConstraint(part: InventoryPart, c: Constraint): ConstraintResult {
  if (c.kind === 'tol') {
    const tolSpec = pickSpec(part.specs, 'tolerance');
    if (!tolSpec?.tol) return { constraint: c, ok: false, why: 'tolerance unknown' };
    const nom = nominal(part);
    if (c.maxPct !== undefined) {
      const pct = worstTolerancePct(tolSpec.tol, nom);
      if (pct === undefined) return { constraint: c, ok: false, why: 'tolerance not comparable' };
      return { constraint: c, ok: pct <= c.maxPct + 1e-9, why: `tolerance ${tolSpec.value}` };
    }
    if (c.maxAbs !== undefined) {
      const t = tolSpec.tol;
      const worst = Math.max(t.minus, t.plus);
      const abs = t.kind === 'absolute' ? (t.unit === c.unit ? worst : undefined) : nom !== undefined ? (worst / 100) * nom : undefined;
      if (abs === undefined) return { constraint: c, ok: false, why: 'tolerance not comparable' };
      return { constraint: c, ok: abs <= c.maxAbs * (1 + 1e-9), why: `tolerance ${tolSpec.value}` };
    }
  }
  if (c.kind === 'value') {
    const s = specFor(part, c.unit);
    if (!s) return { constraint: c, ok: false, why: `${c.unit} spec unknown` };
    // Ranges (e.g. supply 1.2–3.6 V): "eq" means inside the range, "ge" means the range reaches it.
    if (s.num === undefined && s.min !== undefined && s.max !== undefined) {
      const ok = c.op === 'eq' ? c.value >= s.min && c.value <= s.max : c.op === 'ge' ? s.max >= c.value : s.min <= c.value;
      return { constraint: c, ok, why: `${s.name} ${s.value}` };
    }
    if (s.num === undefined) return { constraint: c, ok: false, why: `${s.name} not numeric` };
    const ok = c.op === 'eq' ? approxEqual(s.num, c.value, 1e-3) : c.op === 'ge' ? s.num >= c.value * (1 - 1e-9) : s.num <= c.value * (1 + 1e-9);
    return { constraint: c, ok, why: `${s.name} ${s.value}` };
  }
  return { constraint: c, ok: false, why: 'unsupported' };
}

function haystack(p: InventoryPart): string {
  return [
    p.partId, p.manufacturer, p.mpn, p.description, p.category,
    ...p.skus.map((s) => `${s.sku} ${s.supplier}`),
    ...p.locations.map((l) => `drawer ${l.drawer} ${l.drawer}`),
    ...p.specs.map((s) => `${s.name} ${s.value}`),
  ].join('\n').toLowerCase();
}

export interface SearchHit { part: InventoryPart; score: number; checks: ConstraintResult[] }

export function search(parts: InventoryPart[], input: string): SearchHit[] {
  const q = input.trim();
  if (!q) return parts.map((part) => ({ part, score: 0, checks: [] }));
  const lower = q.toLowerCase();
  // Exact identifier hits first: either supplier SKU or the full manufacturer part number.
  const exact = parts.filter((p) => p.mpn.toLowerCase() === lower || p.skus.some((s) => s.sku.toLowerCase() === lower));
  if (exact.length) return exact.map((part) => ({ part, score: 100, checks: [] }));

  const parsed = parseQuery(q);
  const hits: SearchHit[] = [];
  for (const part of parts) {
    if (parsed.category && part.category !== parsed.category) continue;
    const checks = parsed.constraints.map((c) => checkConstraint(part, c));
    if (checks.some((c) => !c.ok)) continue;
    const hay = haystack(part);
    const termsOk = parsed.terms.every((t) => hay.includes(t.toLowerCase()));
    if (!termsOk) continue;
    hits.push({ part, score: parsed.terms.length + checks.length, checks });
  }
  return hits.sort((a, b) => b.score - a.score || a.part.mpn.localeCompare(b.part.mpn));
}
