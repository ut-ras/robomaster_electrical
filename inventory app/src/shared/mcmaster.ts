// McMaster-Carr bag labels. The label prints:
//   Purchase Order 2650814 / Line 100 / Part Number 31335A12 / <description> / Ordered 2 Each / Shipped 2 Each
// OCR of real bags garbles captions ("Numbgr", "Orde,", "Une", "Ordereg") and adds junk around every line, so the
// parser matches captions loosely, keeps the purchase order and line number out of the part number, and can
// combine several OCR passes of the same photo: each part of the part number (digits, letter, digits) is voted on.
// Nothing here is a catalog lookup; every value is a suggestion the member checks against the photo.

import type { Category, FieldValue, LabelFields } from './types.ts';

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** McMaster part numbers: 3–5 digits, one catalog letter, 1–4 digits (31335A12, 5469K101, 91290A113). */
export const MCMASTER_PN_RE = /^\d{3,5}[A-Z]\d{1,4}$/;

export function detectMcMaster(text: string): string | undefined {
  if (/mc\s*master|master\s*-?\s*car/i.test(text)) return 'label text mentions McMaster-Carr';
  if (/-\s*carr\b/i.test(text)) return 'label text mentions McMaster-Carr';
  if (/purch\w*\s+ord/i.test(text) && /part\s*n\w*/i.test(text) && /\bline\b/i.test(text)) return 'Purchase Order / Line / Part Number label layout';
  return undefined;
}

const clean = (s: string) => s.replace(/[“”«»’‘]/g, (c) => (c === '“' || c === '”' ? '"' : "'"));
// "Part Number", "PartNumber", "Part Numbgr", "Part Mumiy", "Part Nami", "an Number"
const PN_CAPTION = /\b(?:Pa?rt\s*[NM][a-z]{0,6}|[A-Za-z]{0,3}\s*N[uo]mb[a-z]{0,3})\b\W{0,3}/i;
const PO_RE = /\b\w{0,2}rch\w{0,4}\s*O[a-z]{1,4}\W{0,2}\s*(\d[\d ,:]{1,12}\d)/i;
const LINE_RE = /(?:^|[^A-Za-z])(?:Line|Une|Lime|Lne|L1ne)\b\W{0,2}\s*(\d{1,4})\b/i;
const ORDERED_RE = /\bOrder[a-z]{2}\b\W{0,2}\s*(\d{1,5})/i;
const SHIPPED_RE = /\bSh[a-z]{2,5}\b\W{0,2}\s*(\d{1,5})/i;
const STOP_RE = /\b(order[a-z]{2}|sh[il][a-z]{1,4}|packing|each)\b/i;

/**
 * One pass's reading of the part number. `cut` means a junk character is stuck to the last digits
 * ("5469K19+", "5469K10¢"): OCR lost or merged a glyph there, so those last digits do not get a vote.
 */
interface PnVote { prefix: string; letter: string; suffix: string; upper: boolean; cut: boolean }

/** Part-number candidates on the "Part Number" line of one OCR pass. */
function pnCandidates(text: string): { votes: PnVote[]; raw?: string } {
  const lines = clean(text).split(/\r?\n/);
  const votes: PnVote[] = [];
  let raw: string | undefined;
  for (const line of lines) {
    const cap = PN_CAPTION.exec(line);
    if (!cap) continue;
    const rest = line.slice(cap.index + cap[0].length);
    raw ??= rest.trim().split(/\s{2,}/)[0]?.split(/\s+/).slice(0, 2).join(' ');
    // digits, the catalog letter, digits; OCR sometimes splits the number with a space ("5469K 101").
    const m = /(\d{3,5})\s?([A-Za-z])\s?([0-9OoIl]{1,4})/.exec(rest);
    if (m) {
      const [, prefix, letter, suffix] = m;
      const next = rest.charAt(m.index + m[0].length);
      votes.push({ prefix, letter: letter.toUpperCase(), suffix: suffix.replace(/[Oo]/g, '0').replace(/[Il]/g, '1'), upper: letter === letter.toUpperCase(), cut: !!next && !/\s/.test(next) });
    }
  }
  return { votes, raw };
}

/** Weighted vote for each part. A lowercase letter (never printed by McMaster) counts half. */
function vote(values: { v: string; w: number }[]): { value?: string; weight: number; runnerUp: number } {
  const tally = new Map<string, number>();
  for (const { v, w } of values) tally.set(v, (tally.get(v) ?? 0) + w);
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  return { value: sorted[0]?.[0], weight: sorted[0]?.[1] ?? 0, runnerUp: sorted[1]?.[1] ?? 0 };
}

function mode(values: (string | undefined)[]): string | undefined {
  return vote(values.filter((v): v is string => !!v).map((v) => ({ v, w: 1 }))).value;
}

// ---------- description ----------

/** Words McMaster descriptions use, for correcting OCR ("Anodizeq" -> "Anodized"). Extend as needed. */
const VOCAB = [
  'Mating', 'Locating', 'Pin', 'Pins', 'Diameter', 'Round', 'Diamond', 'Anodized', 'Aluminum', 'Rectangular', 'Manifold', 'Outlets',
  'Outlet', 'One', 'Side', 'Sides', 'Two', 'Inlet', 'Steel', 'Stainless', 'Brass', 'Nylon', 'Plastic', 'Alloy', 'Black', 'Oxide',
  'Zinc', 'Plated', 'Socket', 'Head', 'Screw', 'Screws', 'Bolt', 'Bolts', 'Hex', 'Button', 'Flat', 'Pan', 'Washer', 'Washers', 'Nut',
  'Nuts', 'Locknut', 'Thread', 'Threaded', 'Long', 'Length', 'Shoulder', 'Dowel', 'Press', 'Fit', 'Spring', 'Insert', 'Standoff',
  'Female', 'Male', 'Coupling', 'Fitting', 'Bushing', 'Bearing', 'Shaft', 'Collar', 'Clamp', 'Bracket', 'Spacer', 'Thick', 'Wide',
  'Through', 'Hole', 'Tapped', 'Metric', 'Inch', 'Medium', 'Strength', 'Grade', 'Class', 'Tight', 'Tolerance', 'Hardened',
  'NPT', 'NPTF', 'BSPT', 'UNC', 'UNF', 'with', 'for', 'and', 'on', 'of', 'x',
];
const VOCAB_LOWER = new Map(VOCAB.map((w) => [w.toLowerCase(), w]));
const PIPE_SIZES: Record<string, string> = { '18': '1/8', '14': '1/4', '38': '3/8', '12': '1/2', '34': '3/4' };

function correctWord(tok: string): string | undefined {
  const m = /^([A-Za-z]+)([,.;:]?)$/.exec(tok);
  if (!m) return undefined;
  const [word, punct] = [m[1], m[2] === ',' ? ',' : ''];
  const exact = VOCAB_LOWER.get(word.toLowerCase());
  if (exact) return exact + punct;
  if (word.length < 3) return undefined;
  const maxDist = word.length >= 7 ? 2 : 1;
  const w = word.toLowerCase();
  let best: string | undefined; let bestD = maxDist + 1;
  for (const v of VOCAB) {
    if (v.length < 3 || Math.abs(v.length - word.length) > maxDist) continue;
    const d = levenshtein(w, v.toLowerCase());
    if (d < bestD) { best = v; bestD = d; }
  }
  if (best && bestD <= maxDist) return best + punct;
  // a word cut short at the label edge or by glare: "Manifo" / "Manito" -> "Manifold" (5+ letters, 1 edit)
  if (word.length >= 5) {
    for (const v of VOCAB) if (v.length > word.length && levenshtein(w, v.slice(0, word.length).toLowerCase()) <= (w[0] === v[0].toLowerCase() ? 1 : 0)) return v + punct;
  }
  return undefined;
}

const NUM_TOKEN = /^(\d+(?:-\d+)?(?:\/\d+)?|\d*\.\d+)("|mm|in\.?)?,?$/;

/** Keep the longest run of real words on a line, corrected against the vocabulary. Junk around it is dropped. */
function descriptionRun(line: string): { text: string; score: number } {
  const toks = clean(line).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const good: (string | undefined)[] = toks.map((t) => {
    if (NUM_TOKEN.test(t)) return t;
    if (/^[Vv][A4]$/.test(t)) return '1/4'; // OCR of "1/4" on these labels
    if (/^[o0][pnm]$/i.test(t)) return 'on'; // "op", "0n"
    return correctWord(t);
  });
  // two fragments of one word: "Rectan ular" -> "Rectangular"
  for (let i = 0; i + 1 < toks.length; i++) {
    if (good[i] && good[i + 1]) continue;
    const joined = correctWord(toks[i] + toks[i + 1]) ?? correctWord(`${toks[i]}g${toks[i + 1]}`);
    if (joined && joined.length >= 7) { good[i] = joined; good[i + 1] = ''; }
  }
  // pipe sizes lose their slash: "18 NPT" -> "1/8 NPT"
  for (let i = 0; i + 1 < good.length; i++) if (good[i + 1] === 'NPT' && PIPE_SIZES[toks[i]]) good[i] = PIPE_SIZES[toks[i]];
  // A single short junk token between two real words ("Outlets gp One") is skipped, not a break.
  for (let i = 1; i + 1 < good.length; i++) if (good[i] === undefined && toks[i].length <= 3 && good[i - 1] && good[i + 1]) good[i] = '';
  let best: string[] = []; let cur: string[] = [];
  const flush = () => { if (score(cur) > score(best)) best = cur; cur = []; };
  for (const g of good) { if (g === undefined) flush(); else if (g) cur.push(g); }
  flush();
  if (/^\d$/.test(best[0] ?? '')) best = best.slice(1); // a lone digit from the bag edge, not "18-8 Stainless…"
  return { text: best.join(' '), score: score(best) };
}

function score(words: string[]): number {
  const real = words.filter((w) => /[A-Za-z]{3,}/.test(w)).length;
  return real >= 1 && words.length >= 2 ? real + 0.5 * words.filter((w) => /\d/.test(w)).length : 0;
}

/** Description lines sit between the "Part Number" line and "Ordered" / "Shipped" / "on your packing list". */
function describe(text: string): { text: string; score: number }[] {
  const lines = clean(text).split(/\r?\n/);
  const start = lines.findIndex((l) => PN_CAPTION.test(l));
  const from = start >= 0 ? start + 1 : 0;
  const runs: { text: string; score: number }[] = [];
  for (let i = from; i < lines.length && runs.length < 3; i++) {
    if (STOP_RE.test(lines[i])) break;
    const r = descriptionRun(lines[i]);
    if (r.score >= 1.5 || (runs.length && r.score >= 1)) runs.push(r);
  }
  return runs;
}

/** For each description line, the best-scoring read across passes (passes garble different lines). */
function bestDescription(passes: string[]): string | undefined {
  const all = passes.map(describe);
  const slots = Math.max(0, ...all.map((r) => r.length));
  const picked: string[] = [];
  for (let k = 0; k < slots; k++) {
    let best: { text: string; score: number } | undefined;
    for (const runs of all) if (runs[k] && (!best || runs[k].score > best.score)) best = runs[k];
    if (best) picked.push(best.text);
  }
  return picked.join(' ').replace(/\s+,/g, ',').trim() || undefined;
}

// ---------- category and specs from the description ----------

export function hardwareFromDescription(description: string): { category: Category; specs: { name: string; value: string }[] } {
  const d = description;
  const category: Category = /manifold/i.test(d) ? 'manifold' : /washer/i.test(d) ? 'washer' : /\b(lock)?nuts?\b/i.test(d) ? 'nut'
    : /\bbolts?\b/i.test(d) ? 'bolt' : /\bscrews?\b/i.test(d) ? 'screw' : /\bpins?\b/i.test(d) ? 'pin' : 'hardware';
  const specs: { name: string; value: string }[] = [];
  const dia = /(\d+(?:-\d+)?\/\d+|\d*\.\d+|\d+)\s*(?:"|-inch|\s?in\.?)\s*(?:Diameter|Dia\.?|OD)\b/i.exec(d) ?? /(\d+(?:\.\d+)?)\s*mm\s*(?:Diameter|Dia\.?|OD)\b/i.exec(d);
  if (dia) specs.push({ name: 'Diameter', value: /mm/i.test(dia[0]) ? `${dia[1]} mm` : `${dia[1]} in` });
  const len = /(\d+(?:-\d+)?\/\d+|\d*\.\d+|\d+)\s*(?:"|-inch|\s?in\.?)\s*Long\b/i.exec(d) ?? /(\d+(?:\.\d+)?)\s*mm\s*Long\b/i.exec(d);
  if (len) specs.push({ name: 'Length', value: /mm/i.test(len[0]) ? `${len[1]} mm` : `${len[1]} in` });
  const pipes = [...d.matchAll(/(\d+\/\d+|\d+)\s*(NPTF?|BSPT)\b/g)].map((m) => `${m[1]} ${m[2]}`);
  if (pipes.length) specs.push({ name: 'Pipe thread', value: pipes.join(' × ') });
  const outlets = /(\d+)\s*Outlets?\b/i.exec(d);
  if (outlets) specs.push({ name: 'Outlets', value: outlets[1] });
  const metric = /\bM(\d+(?:\.\d+)?)\s*x\s*(\d*\.\d+)\s*mm\b/i.exec(d);
  if (metric) { specs.push({ name: 'Thread size', value: `M${metric[1]}` }); specs.push({ name: 'Thread pitch', value: `${metric[2]} mm` }); }
  const imperial = /(#\d{1,2}|\d+\/\d+)"?\s*-\s*(\d{1,3})\b/.exec(d);
  if (!metric && imperial) { specs.push({ name: 'Thread size', value: imperial[1].startsWith('#') ? imperial[1] : `${imperial[1]}"` }); specs.push({ name: 'Threads per inch', value: imperial[2] }); }
  const material = /\b(Anodized Aluminum|Aluminum|Stainless Steel|Alloy Steel|Black-Oxide \w+ Steel|Zinc-Plated Steel|Steel|Brass|Nylon|Plastic)\b/i.exec(d);
  if (material) specs.push({ name: 'Material', value: material[1] });
  if (/\bRound\b/.test(d) && category === 'pin') specs.push({ name: 'Shape', value: 'Round' });
  return { category, specs };
}

// ---------- the label ----------

/**
 * Parse one or more OCR passes of a McMaster-Carr label. `texts[0]` is the normal pass; extra passes of the
 * same photo (other sizes / contrast) only help when they agree with each other.
 */
export function parseMcMasterTexts(texts: string[]): LabelFields {
  const passes = texts.filter((t) => typeof t === 'string');
  const out: LabelFields = {};
  const info: NonNullable<LabelFields['mcmaster']> = { reads: passes.length };

  const po = mode(passes.map((t) => PO_RE.exec(clean(t))?.[1].replace(/[\s,:]/g, '')));
  if (po) info.purchaseOrder = po;
  const line = mode(passes.map((t) => LINE_RE.exec(clean(t))?.[1]));
  if (line) info.line = line;
  const ordered = mode(passes.map((t) => ORDERED_RE.exec(t)?.[1]));
  if (ordered) info.ordered = ordered;
  const shipped = mode(passes.map((t) => SHIPPED_RE.exec(t)?.[1]));
  if (shipped) info.shipped = shipped;
  out.mcmaster = info;

  // Part number
  const found = passes.map(pnCandidates);
  const votes = found.flatMap((f) => f.votes);
  const notPoOrLine = (pn: string) => pn !== po && pn !== line;
  const first = found[0]?.votes[0];
  const firstPn = first && first.upper ? `${first.prefix}${first.letter}${first.suffix}` : undefined;
  let sku: FieldValue | undefined;
  if (firstPn && !first!.cut && MCMASTER_PN_RE.test(firstPn) && notPoOrLine(firstPn) && passes.length === 1) {
    sku = { value: firstPn, source: 'ocr', confidence: 0.8, verifiedBy: 'text after "Part Number"' };
  } else if (votes.length) {
    // Each part is voted on separately. A lowercase letter counts half; cut-off last digits do not count.
    const w = (v: PnVote) => (v.upper ? 1 : 0.5);
    const p = vote(votes.map((v) => ({ v: v.prefix, w: w(v) })));
    const l = vote(votes.map((v) => ({ v: v.letter, w: w(v) })));
    const s = vote(votes.filter((v) => !v.cut).map((v) => ({ v: v.suffix, w: w(v) })));
    const pn = `${p.value}${l.value}${s.value ?? ''}`;
    // Auto-fill only when at least two reads agree on every part and nothing disagrees as strongly.
    const agreed = [p, l, s].every((x) => x.weight >= 2 && x.weight > x.runnerUp);
    const single = votes.length === 1 && votes[0].upper && !votes[0].cut;
    if (MCMASTER_PN_RE.test(pn) && notPoOrLine(pn) && (agreed || single)) {
      sku = { value: pn, source: 'ocr', confidence: agreed ? 0.75 : 0.6, verifiedBy: agreed ? `text after "Part Number", ${votes.length} of ${passes.length} reads` : 'text after "Part Number"' };
    } else {
      out.guesses = { sku: MCMASTER_PN_RE.test(pn) ? pn : found.find((f) => f.raw)?.raw };
    }
  } else {
    const raw = found.find((f) => f.raw)?.raw;
    if (raw) out.guesses = { sku: raw };
  }
  // Fallback: a clean McMaster-format token anywhere except on the PO / line lines.
  if (!sku && !out.guesses?.sku) {
    for (const t of passes) for (const l of clean(t).split(/\r?\n/)) {
      if (PO_RE.test(l) || LINE_RE.test(l)) continue;
      const m = /\b(\d{3,5}[A-Z]\d{1,4})\b/.exec(l);
      if (m && notPoOrLine(m[1])) { out.guesses = { sku: m[1] }; break; }
    }
  }
  if (sku) { out.sku = sku; out.mpn = { ...sku }; }
  out.manufacturer = { value: 'McMaster-Carr', source: 'ocr', confidence: 0.9, verifiedBy: 'McMaster-Carr label' };

  // Description: per line, the best read across passes, corrected against the vocabulary.
  const best = bestDescription(passes);
  if (best) {
    out.description = { value: best, source: 'ocr', confidence: 0.5, verifiedBy: passes.length > 1 ? `best line of ${passes.length} reads` : undefined };
    out.hardware = hardwareFromDescription(best);
  }
  // Label quantities are what was ordered and shipped; the member counts what is actually in the bag.
  if (shipped) out.quantity = { value: shipped, source: 'ocr', confidence: 0.5, verifiedBy: 'label "Shipped" quantity' };
  out.partNumberStatus = out.sku ? 'ok' : 'unreadable';
  return out;
}
