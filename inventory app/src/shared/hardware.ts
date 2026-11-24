// Mechanical hardware: categories, spec templates, thread sizes, and the "no drawer" location.
// Shared by the server and the phone. Metric and imperial threads are kept distinct everywhere:
// a size is metric only as "M<diameter>", imperial only as "#<number>" or an inch size.

import type { Category } from './types.ts';
import { INCH_NUMBER, inchValue, parseLength } from './units.ts';

// ---------- drawers ----------

/** Stored in the Locations and Stock Ledger tabs for a part that has no drawer. One such location per part. */
export const UNASSIGNED_DRAWER = 'Not specified';

/** Trim and collapse spaces. Blank (or whitespace, or "Not specified") means the part's unassigned location. */
export function normDrawer(d: string | undefined | null): string {
  const t = String(d ?? '').trim().replace(/\s+/g, ' ');
  return !t || t.toLowerCase() === UNASSIGNED_DRAWER.toLowerCase() ? UNASSIGNED_DRAWER : t;
}

export const isUnassigned = (d: string | undefined | null) => normDrawer(d) === UNASSIGNED_DRAWER;

// ---------- categories ----------

export const HARDWARE_CATEGORIES: { value: Category; label: string }[] = [
  { value: 'screw', label: 'Screw' },
  { value: 'bolt', label: 'Bolt' },
  { value: 'nut', label: 'Nut' },
  { value: 'washer', label: 'Washer' },
  { value: 'pin', label: 'Pin' },
  { value: 'manifold', label: 'Manifold' },
  { value: 'hardware', label: 'Other' },
];

export const ALL_CATEGORIES: Category[] = ['capacitor', 'resistor', 'inductor', 'ic', 'connector', 'other', ...HARDWARE_CATEGORIES.map((c) => c.value)];

export function isCategory(c: unknown): c is Category {
  return typeof c === 'string' && (ALL_CATEGORIES as string[]).includes(c);
}

export function isHardwareCategory(c: unknown): boolean {
  return HARDWARE_CATEGORIES.some((h) => h.value === c);
}

export function categoryLabel(c: string): string {
  return HARDWARE_CATEGORIES.find((h) => h.value === c)?.label ?? c;
}

/** Threaded categories get a metric / imperial choice. */
export const THREADED: Category[] = ['screw', 'bolt', 'nut'];

/**
 * Spec fields offered per category. `kind` drives the input:
 *  thread = thread size (format depends on the thread system), pitch = "Thread pitch" (metric, mm) or
 *  "Threads per inch" (imperial), length = number + unit, int = whole number, text = free text.
 */
export interface SpecField { name: string; kind: 'thread' | 'pitch' | 'length' | 'int' | 'text'; placeholder?: string }

export const SPEC_TEMPLATES: Record<string, SpecField[]> = {
  screw: [
    { name: 'Thread size', kind: 'thread' }, { name: 'Pitch', kind: 'pitch' }, { name: 'Length', kind: 'length' },
    { name: 'Head style', kind: 'text', placeholder: 'e.g. Socket head, Button head, Flat head' }, { name: 'Material', kind: 'text', placeholder: 'e.g. Black-oxide alloy steel' },
  ],
  bolt: [
    { name: 'Thread size', kind: 'thread' }, { name: 'Pitch', kind: 'pitch' }, { name: 'Length', kind: 'length' },
    { name: 'Head style', kind: 'text', placeholder: 'e.g. Hex head' }, { name: 'Material', kind: 'text', placeholder: 'e.g. Zinc-plated steel' },
  ],
  nut: [{ name: 'Thread size', kind: 'thread' }, { name: 'Pitch', kind: 'pitch' }, { name: 'Material', kind: 'text', placeholder: 'e.g. Nylon-insert locknut, steel' }],
  washer: [
    { name: 'Inner diameter', kind: 'length' }, { name: 'Outer diameter', kind: 'length' }, { name: 'Thickness', kind: 'length' },
    { name: 'For screw size', kind: 'text', placeholder: 'e.g. M3 or #4' }, { name: 'Material', kind: 'text' },
  ],
  pin: [{ name: 'Diameter', kind: 'length' }, { name: 'Length', kind: 'length' }, { name: 'Material', kind: 'text' }],
  manifold: [
    { name: 'Pipe thread', kind: 'text', placeholder: 'e.g. 1/4 NPT × 1/8 NPT' }, { name: 'Outlets', kind: 'int' }, { name: 'Material', kind: 'text', placeholder: 'e.g. Anodized aluminum' },
  ],
  hardware: [],
};

// ---------- thread sizes ----------

export type ThreadSystem = 'metric' | 'imperial';
export interface ThreadSize { system: ThreadSystem; size: string; diameter: number /* metres */ }

const NUMBER_SIZE_RE = /^(?:#|No\.?\s*)\s*(\d{1,2})$/i;
const METRIC_SIZE_RE = /^M\s*(\d+(?:\.\d+)?)$/i;
const INCH_SIZE_RE = new RegExp(String.raw`^(${INCH_NUMBER})\s*("|”|″|in(?:ch)?\.?)?$`, 'i');

/**
 * "M3" -> metric 3 mm. "#4" / "No. 4" -> imperial number size. '1/4"' / "1/4 in" -> imperial; a bare "1/4"
 * counts as imperial only when the system is known to be imperial. Returns undefined when the text does not
 * fit the requested system, so "M3" is never accepted as imperial or "1/4" as metric.
 */
export function parseThreadSize(text: string, system?: ThreadSystem): ThreadSize | undefined {
  const t = String(text ?? '').trim();
  const m = METRIC_SIZE_RE.exec(t);
  if (m) return system === 'imperial' ? undefined : { system: 'metric', size: `M${Number(m[1])}`, diameter: Number(m[1]) / 1000 };
  const n = NUMBER_SIZE_RE.exec(t);
  if (n) return system === 'metric' ? undefined : { system: 'imperial', size: `#${Number(n[1])}`, diameter: (0.06 + 0.013 * Number(n[1])) * 0.0254 };
  const f = INCH_SIZE_RE.exec(t);
  if (f && system !== 'metric' && (f[2] || system === 'imperial')) {
    const v = inchValue(f[1]);
    if (v && v > 0 && v < 4) return { system: 'imperial', size: `${f[1].replace(/\s+/g, ' ')}"`, diameter: v * 0.0254 };
  }
  return undefined;
}

export function sameThread(a: ThreadSize, b: ThreadSize): boolean {
  return a.system === b.system && Math.abs(a.diameter - b.diameter) <= 1e-3 * Math.max(a.diameter, b.diameter);
}

// ---------- validating what the hardware form sends ----------

export interface HardwareSpecInput { name: string; value: string }

/**
 * Normalise and check member-entered hardware specs. Thread sizes must match the chosen thread system;
 * "Thread pitch" is metric only and "Threads per inch" imperial only, so the two never mix.
 * Returns the cleaned specs (plus a "Thread system" row for threaded parts) or the first problem found.
 */
export function cleanHardwareSpecs(category: Category, system: ThreadSystem | undefined, specs: HardwareSpecInput[]): { specs: HardwareSpecInput[] } | { error: string } {
  const out: HardwareSpecInput[] = [];
  const threaded = THREADED.includes(category);
  for (const raw of specs) {
    const name = String(raw?.name ?? '').trim().replace(/\s+/g, ' ');
    let value = String(raw?.value ?? '').trim().replace(/\s+/g, ' ');
    if (!name || !value) continue;
    const lower = name.toLowerCase();
    if (lower === 'thread system') continue; // derived below
    if (lower === 'thread size' || lower === 'for screw size') {
      const sys = lower === 'thread size' && threaded ? system : undefined;
      const t = parseThreadSize(value, sys);
      if (!t) {
        if (lower === 'thread size' && threaded) {
          return { error: system === 'imperial'
            ? `"${value}" is not an imperial thread size. Use a number size like #4 or an inch size like 1/4". For metric, choose Metric.`
            : `"${value}" is not a metric thread size. Use M3, M4, M5… For #4 or 1/4", choose Imperial.` };
        }
        out.push({ name, value }); // free text, e.g. "fits 1/4 bolts"
        continue;
      }
      value = t.size;
    } else if (lower === 'thread pitch') {
      if (system === 'imperial') return { error: 'Imperial threads use threads per inch, not a pitch in mm.' };
      const p = parseLength(/\d$/.test(value) ? `${value} mm` : value);
      if (p === undefined || p <= 0 || p > 0.01) return { error: `Thread pitch "${value}" should be in mm, e.g. 0.5 mm.` };
      value = `${Number((p * 1000).toPrecision(4))} mm`;
    } else if (lower === 'threads per inch') {
      if (system === 'metric') return { error: 'Metric threads use a pitch in mm, not threads per inch.' };
      if (!/^\d{1,3}$/.test(value)) return { error: `Threads per inch should be a whole number, e.g. 20 (got "${value}").` };
    }
    out.push({ name, value });
  }
  if (threaded) {
    const size = out.find((s) => s.name.toLowerCase() === 'thread size');
    const sys = size ? parseThreadSize(size.value)?.system : system;
    if (sys) out.unshift({ name: 'Thread system', value: sys === 'metric' ? 'Metric' : 'Imperial (inch)' });
  }
  return { specs: out };
}

// ---------- hardware terms in a search ----------

export type HardwareConstraint =
  | { kind: 'thread'; thread: ThreadSize; pitch?: number; tpi?: number; text: string }
  | { kind: 'dim'; key?: 'length'; value: number; text: string };

const LEN_NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const INCH_TAIL = String.raw`(?:"|”|″|in(?:ch(?:es)?)?\b\.?)`;

/**
 * Pull hardware sizes out of a search and return what is left for the other parsers.
 *  "M3 x 8 mm", "M3x8", "M3-0.5 x 12mm", "M3 x 0.5 x 8"  -> metric thread (+pitch) (+length)
 *  "1/4-20 x 3/4", '#4-40 x 1/2"', "#10"                 -> imperial thread (+TPI) (+length, inches)
 *  "8 mm", '5/16"', "3/4 in"                             -> any dimension of that size
 */
export function takeHardwareTerms(input: string): { constraints: HardwareConstraint[]; rest: string } {
  let q = input.replace(/×/g, 'x');
  const out: HardwareConstraint[] = [];
  // Each pattern: find every match in what is left, use it (unless it follows "drawer"), then blank it out.
  const takeAll = (re: RegExp, use: (m: RegExpExecArray) => boolean | void) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    const hits = [...q.matchAll(g)] as RegExpExecArray[];
    for (const m of hits.reverse()) {
      if (/drawer\s*$/i.test(q.slice(0, m.index))) continue; // "drawer M1" is a drawer name, left for text search
      if (use(m) === false) continue;
      q = q.slice(0, m.index) + ' ' + q.slice(m.index + m[0].length);
    }
  };
  // Matches are used last-first (so blanking one does not shift the others); inserting at the front keeps query order.
  const before = out.length;
  const add = (c: HardwareConstraint) => { out.splice(before, 0, c); };

  takeAll(new RegExp(String.raw`(?<![\w.])M\s?(\d+(?:\.\d+)?)(?:\s*-\s*${LEN_NUM})?((?:\s*x\s*${LEN_NUM}\s*(?:mm)?(?![\w.]))*)`, 'i'), (m) => {
    const xs = [...(m[3] ?? '').matchAll(new RegExp(String.raw`x\s*${LEN_NUM}`, 'gi'))].map((x) => parseFloat(x[1]));
    const pitchMm = m[2] !== undefined ? parseFloat(m[2]) : xs.length >= 2 ? xs[0] : undefined;
    const lengthMm = xs.length ? xs[xs.length - 1] : undefined;
    if (lengthMm !== undefined) add({ kind: 'dim', key: 'length', value: lengthMm / 1000, text: `x ${lengthMm} mm` });
    add({ kind: 'thread', thread: parseThreadSize(`M${m[1]}`)!, pitch: pitchMm !== undefined ? pitchMm / 1000 : undefined, text: m[0].trim() });
  });

  takeAll(new RegExp(String.raw`(?<![\w.\/])(#\s?\d{1,2}|${INCH_NUMBER}\s*${INCH_TAIL}?)\s*-\s*(\d{1,3})(?![\d.\/])(?:\s*x\s*(${INCH_NUMBER})\s*${INCH_TAIL}?)?`, 'i'), (m) => {
    const thread = parseThreadSize(m[1].replace(/\s+/g, ''), 'imperial') ?? parseThreadSize(m[1], 'imperial');
    if (!thread) return false;
    const len = m[3] !== undefined ? inchValue(m[3]) : undefined;
    if (len !== undefined) add({ kind: 'dim', key: 'length', value: len * 0.0254, text: `x ${m[3]} in` });
    add({ kind: 'thread', thread, tpi: Number(m[2]), text: m[0].trim() });
  });

  takeAll(/(?<![\w.])#\s?(\d{1,2})(?:\s*x\s*(\S+?)\s*(?:"|in\b)?)?(?![\w.])/i, (m) => {
    const len = m[2] !== undefined ? inchValue(m[2].replace(/["]/g, '')) : undefined;
    if (len !== undefined) add({ kind: 'dim', key: 'length', value: len * 0.0254, text: `x ${m[2]} in` });
    add({ kind: 'thread', thread: parseThreadSize(`#${m[1]}`)!, text: m[0].trim() });
  });

  takeAll(new RegExp(String.raw`(?<![\w.\/])${LEN_NUM}\s*(mm|cm)\b`, 'i'), (m) => {
    add({ kind: 'dim', value: parseFloat(m[1]) / (m[2].toLowerCase() === 'cm' ? 100 : 1000), text: m[0].trim() });
  });
  takeAll(new RegExp(String.raw`(?<![\w.\/-])(${INCH_NUMBER})\s*${INCH_TAIL}`, 'i'), (m) => {
    const v = inchValue(m[1]);
    if (v === undefined) return false;
    add({ kind: 'dim', value: v * 0.0254, text: m[0].trim() });
  });
  return { constraints: out, rest: q };
}

/** Spec keys that hold a physical dimension, searched by a bare size such as "8 mm" or 5/16". */
export const DIMENSION_KEYS = ['length', 'diameter', 'inner_diameter', 'outer_diameter', 'thickness', 'pitch', 'thread_pitch'];
