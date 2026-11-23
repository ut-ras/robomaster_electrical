// Engineering-value parsing: SI prefixes, units, ranges, tolerances and test conditions.
// All parsed numbers are in SI base units (F, Ω, H, V, A, W, Hz, m). The original text is never modified.

import type { Tolerance } from './types.ts';

const PREFIX: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9,
};

/** Normalise unicode minus/dash and "+/-" so later regexes only need ASCII forms. */
export function normText(s: string): string {
  return s
    .replace(/[−‒–—]/g, '-')
    .replace(/\+\/-|\+-(?=\s*\d)/g, '±')
    .replace(/ /g, ' ')
    .replace(/\bohms?\b/gi, 'Ω')
    .replace(/(\d)\s*Ohms?\b/g, '$1Ω')
    .replace(/([pnuµμmkKMG])Ohms?\b/g, '$1Ω');
}

const UNIT_ALIASES: [RegExp, string][] = [
  [/^F$/, 'F'],
  [/^(Ω|R)$/, 'Ω'],
  [/^H$/, 'H'],
  [/^(V|VDC|VAC|Vdc|Vac|V DC|V AC)$/, 'V'],
  [/^A$/, 'A'],
  [/^W$/, 'W'],
  [/^Hz$/, 'Hz'],
];

// number, optional space, optional prefix, unit. Unit list is ordered so "Hz" wins over "H".
const QTY_RE = /(\d+(?:\.\d+)?|\.\d+)\s*(p|n|u|µ|μ|m|k|K|M|G)?\s*(Hz|F|Ω|H|VDC|VAC|Vdc|Vac|V|A|W)(?![a-zA-Z])/;
const QTY_RE_G = new RegExp(QTY_RE.source, 'g');

export interface Quantity { value: number; unit: string; text: string }

function toQuantity(m: RegExpExecArray | RegExpMatchArray): Quantity | undefined {
  const num = parseFloat(m[1]);
  const prefix = m[2] ?? '';
  let unit = m[3];
  for (const [re, canon] of UNIT_ALIASES) if (re.test(unit)) { unit = canon; break; }
  const mult = PREFIX[prefix];
  if (mult === undefined || !Number.isFinite(num)) return undefined;
  return { value: num * mult, unit, text: m[0] };
}

/** Parse every number+unit in the text, e.g. "1.2 V ~ 3.6 V" -> two quantities. Handles "1/4W". */
export function parseQuantities(text: string): Quantity[] {
  const t = normText(text);
  const out: Quantity[] = [];
  const frac = /(\d+)\/(\d+)\s*W(?![a-zA-Z])/g;
  for (const m of t.matchAll(frac)) out.push({ value: Number(m[1]) / Number(m[2]), unit: 'W', text: m[0] });
  for (const m of t.matchAll(QTY_RE_G)) {
    // skip the denominator of "1/4W" which the generic regex would also see as "4W"
    if (m.index && t[m.index - 1] === '/') continue;
    const q = toQuantity(m);
    if (q) out.push(q);
  }
  return out;
}

export function parseQuantity(text: string): Quantity | undefined {
  return parseQuantities(text)[0];
}

/** Lengths printed as mm or inches, e.g. '0.100" (2.54mm)'. Returns metres. */
export function parseLength(text: string): number | undefined {
  const mm = /(\d+(?:\.\d+)?)\s*mm\b/.exec(text);
  if (mm) return parseFloat(mm[1]) / 1000;
  const inch = /(\d*\.?\d+)\s*(?:"|in\b)/.exec(text);
  if (inch) return parseFloat(inch[1]) * 0.0254;
  return undefined;
}

/** "1.65V ~ 3.6V", "1.2 V to 3.6 V", "-40°C ~ 125°C" -> {min,max}. */
export function parseRange(text: string): { min: number; max: number; unit: string } | undefined {
  const t = normText(text);
  if (!/(~|\bto\b|\.\.\.|–)/.test(t) && !/\d\s*-\s*\d.*\d/.test(t)) {
    // a single quantity is not a range
  }
  const qs = parseQuantities(t);
  if (qs.length >= 2 && qs[0].unit === qs[1].unit && /(~|\bto\b|\.\.\.)/.test(t)) {
    const [a, b] = [qs[0].value, qs[1].value];
    return { min: Math.min(a, b), max: Math.max(a, b), unit: qs[0].unit };
  }
  const temp = /(-?\d+(?:\.\d+)?)\s*°?C\s*(?:~|to)\s*\+?(-?\d+(?:\.\d+)?)\s*°?C/.exec(t);
  if (temp) return { min: parseFloat(temp[1]), max: parseFloat(temp[2]), unit: '°C' };
  return undefined;
}

/**
 * Tolerance parser. Preserves asymmetric and absolute forms.
 *  "±10%" -> percent 10/10, "-20%, +80%" -> percent 20/80, "±0.1pF" -> absolute 1e-13 F.
 *  Returns undefined for "-", "", "N/A" (unknown).
 */
export function parseTolerance(text: string): Tolerance | undefined {
  const t = normText(text).trim();
  if (!t || /^(-|—|n\/?a|unknown|\?)$/i.test(t)) return undefined;

  const plus = /\+\s*(\d+(?:\.\d+)?)\s*%/.exec(t);
  const minus = /(?:^|[^\d.])-\s*(\d+(?:\.\d+)?)\s*%/.exec(t);
  if (plus && minus) return { kind: 'percent', minus: parseFloat(minus[1]), plus: parseFloat(plus[1]) };

  const sym = /±\s*(\d+(?:\.\d+)?)\s*%/.exec(t);
  if (sym) { const v = parseFloat(sym[1]); return { kind: 'percent', minus: v, plus: v }; }

  const absSym = /±\s*(\d+(?:\.\d+)?)\s*(p|n|u|µ|μ|m|k|K|M)?\s*(F|Ω|H|V|A)/.exec(t);
  if (absSym) {
    const v = parseFloat(absSym[1]) * PREFIX[absSym[2] ?? ''];
    return { kind: 'absolute', minus: v, plus: v, unit: absSym[3] };
  }

  const bare = /^(\d+(?:\.\d+)?)\s*%$/.exec(t);
  if (bare) { const v = parseFloat(bare[1]); return { kind: 'percent', minus: v, plus: v }; }
  return undefined;
}

/** Worst-case tolerance as a fraction of nominal. Absolute tolerances need the nominal value. */
export function worstTolerancePct(tol: Tolerance | undefined, nominal?: number): number | undefined {
  if (!tol) return undefined;
  const worst = Math.max(tol.minus, tol.plus);
  if (tol.kind === 'percent') return worst;
  if (nominal && nominal > 0) return (worst / nominal) * 100;
  return undefined;
}

/** Test condition text: "100mΩ @ 100kHz" -> "@ 100kHz"; "(at 25°C)" -> "at 25°C". */
export function parseCondition(text: string): string | undefined {
  const at = /@\s*(.+)$/.exec(text);
  if (at) return '@ ' + at[1].trim();
  const paren = /\(([^)]*(?:Hz|°C|V|A)[^)]*)\)/.exec(text);
  if (paren) return paren[1].trim();
  return undefined;
}

const DISPLAY_PREFIX: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];

/** 1e-7, 'F' -> "100 nF" */
export function formatSI(value: number, unit: string): string {
  if (value === 0) return `0 ${unit}`;
  const abs = Math.abs(value);
  for (const [mult, p] of DISPLAY_PREFIX) {
    if (abs >= mult * 0.9999) {
      const n = value / mult;
      return `${Number(n.toPrecision(4))} ${p}${unit}`;
    }
  }
  return `${value} ${unit}`;
}

/** Relative equality for engineering values (100 nF == 0.1 µF). */
export function approxEqual(a: number, b: number, rel = 1e-6): boolean {
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
}
