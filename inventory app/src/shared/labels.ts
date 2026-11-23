// Turn OCR text and decoded barcodes from a Mouser or DigiKey bag label into structured fields.
// Part numbers are kept verbatim: commas, suffixes and leading zeros are significant.

import type { BarcodeHit, FieldValue, LabelFields, OcrLine, Supplier } from './types.ts';

export function detectSupplier(text: string, barcodes: string[] = []): { value: Supplier; reason: string } | undefined {
  const all = `${text}\n${barcodes.join('\n')}`;
  if (/mouser/i.test(all) || /mouser\s*p\s*\/?\s*n/i.test(all)) return { value: 'mouser', reason: 'label text mentions Mouser' };
  if (/digi\s*-?\s*key/i.test(all)) return { value: 'digikey', reason: 'label text mentions DigiKey' };
  if (/\b[0-9A-Z][0-9A-Z.\-/#]*-ND\b/.test(all)) return { value: 'digikey', reason: 'found a DigiKey "-ND" part number' };
  if (/\b\d{2,3}-[A-Z0-9][A-Z0-9\-,./#]{3,}/.test(all) && /mfg\s*p\/?n/i.test(all)) return { value: 'mouser', reason: 'Mouser-style "NNN-" part number with MFG P/N field' };
  return undefined;
}

/** Fix characters OCR commonly confuses, only where the format makes the intent unambiguous. */
function cleanMouserSku(raw: string): string {
  const m = /^([0-9OoIlSB]{2,3})-(.+)$/.exec(raw);
  if (!m) return raw;
  const prefix = m[1].replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  return `${prefix}-${m[2]}`;
}

const PN_CHARS = "[A-Za-z0-9][A-Za-z0-9\\-,./#+()]*[A-Za-z0-9)#]|[A-Za-z0-9]";

function field(value: string | undefined, source: FieldValue['source'], confidence: number): FieldValue | undefined {
  if (!value) return undefined;
  const v = value.trim();
  return v ? { value: v, source, confidence } : undefined;
}

/** Manufacturer names seen on labels mapped to how catalogs print them. Extend as the team buys more. */
const KNOWN_MANUFACTURERS = [
  'Nexperia', 'Texas Instruments', 'TI', 'Molex', 'TDK', 'Murata', 'KEMET', 'Yageo', 'Vishay', 'Samsung',
  'Panasonic', 'AVX', 'KYOCERA AVX', 'Bourns', 'TE Connectivity', 'Amphenol', 'JST', 'Würth', 'Wurth',
  'Microchip', 'STMicroelectronics', 'Analog Devices', 'onsemi', 'ON Semiconductor', 'Infineon', 'NXP',
  'Diodes', 'Littelfuse', 'Coilcraft', 'Sullins', 'Harwin', 'Hirose', 'Taiyo Yuden', 'Stackpole', 'Rohm', 'EPCOS',
];

function findManufacturer(lines: string[]): string | undefined {
  for (const line of lines) {
    for (const name of KNOWN_MANUFACTURERS) {
      const re = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|,)`, 'i');
      if (re.test(line)) {
        // return the full company line for DigiKey ("TDK ELECTRONICS INC"), just the name for Mouser desc lines
        const company = /^[A-Z0-9 &.,'-]+(INC|CORP|CORPORATION|LLC|LTD|CO|GMBH|AG|ELECTRONICS|CONNECTIVITY)\.?$/i.exec(line.trim());
        return company ? line.trim() : name;
      }
    }
  }
  return undefined;
}

export function parseMouserText(text: string): LabelFields {
  // OCR of real bags often prefixes lines with junk from the bag edge ("| Desc: ...", "/ MFG P/N: ...").
  const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/^[^A-Za-z0-9]+\s*/, '')).filter(Boolean);
  const joined = lines.join('\n');
  const out: LabelFields = {};
  const sku = new RegExp(`Mouser\\s*P\\s*/?\\s*N\\s*[:;.]?\\s*(${PN_CHARS})`, 'i').exec(joined);
  if (sku) out.sku = field(cleanMouserSku(sku[1]), 'ocr', 0.8);
  const mpn = new RegExp(`MFG\\s*P\\s*/?\\s*N\\s*[:;.]?\\s*(${PN_CHARS})`, 'i').exec(joined);
  if (mpn) out.mpn = field(mpn[1], 'ocr', 0.8);
  const qty = /\b(?:QTY|Q[T7]Y|[0O]TY)\s*[:;.]?\s*([0-9][0-9,]*)/i.exec(joined);
  if (qty) out.quantity = field(qty[1].replace(/,/g, ''), 'ocr', 0.8);

  // "Desc:" may follow a stray OCR character from the bag edge ("f Desc: ..."), so allow a short prefix.
  const descIdx = lines.findIndex((l) => /^.{0,3}\bDesc\s*[:;.]/i.test(l));
  if (descIdx >= 0) {
    const first = lines[descIdx].replace(/^.{0,3}\bDesc\s*[:;.]\s*/i, '').replace(/(\s+[^A-Za-z0-9\s]+)+\s*$/, '');
    const next = lines[descIdx + 1] && !/^(RoHS|QTY|COO|Invoice)/i.test(lines[descIdx + 1]) ? lines[descIdx + 1] : '';
    out.description = field([first, next].filter(Boolean).join(' / '), 'ocr', 0.6);
    const mfr = findManufacturer([next, first].filter(Boolean));
    if (mfr) out.manufacturer = field(mfr, 'ocr', 0.7);
    else if (next) out.manufacturer = field(next.split(/\s{2,}|\s/)[0], 'ocr', 0.3);
  }
  return out;
}

const DK_DESC_START = /^(CAP|RES|IC|CONN|IND|FIXED IND|DIODE|TRANS|MOSFET|LED|XTAL|CRYSTAL|FUSE|SWITCH|RELAY|SENSOR|FERRITE|TERM|HEADER|JUMPER|BATT|CABLE|WIRE|SOCKET|HOUSING|CONTACT)\b/i;

export function parseDigikeyText(text: string): LabelFields {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: LabelFields = {};
  const skuRe = /\b([0-9A-Z][0-9A-Z\-./#]*-ND)\b/i;
  const skuIdx = lines.findIndex((l) => skuRe.test(l));
  if (skuIdx >= 0) out.sku = field(skuRe.exec(lines[skuIdx])![1].toUpperCase().replace(/-ND$/, '-ND'), 'ocr', 0.8);

  // MPN: explicit "MFG/MPN" label, otherwise the first part-number-looking token on the line after the SKU.
  const mpnLabeled = new RegExp(`\\b(?:MFG|MPN|MFR)\\s*(?:P\\s*/?\\s*N)?\\s*[:#]?\\s*(${PN_CHARS})`, 'i').exec(lines.join('\n'));
  if (mpnLabeled) out.mpn = field(mpnLabeled[1], 'ocr', 0.7);
  else if (skuIdx >= 0) {
    for (const l of lines.slice(skuIdx + 1, skuIdx + 3)) {
      const tok = l.replace(/^(MFG|MPN|MFR)\s*/i, '').split(/\s+/)[0];
      if (tok && /\d/.test(tok) && /^[A-Za-z0-9][A-Za-z0-9\-,./#+]{3,}$/.test(tok) && !DK_DESC_START.test(l)) {
        out.mpn = field(tok, 'ocr', 0.6);
        break;
      }
    }
  }

  const desc = lines.find((l) => DK_DESC_START.test(l.replace(/^DESC\s*/i, '')));
  if (desc) out.description = field(desc.replace(/^DESC\s*/i, ''), 'ocr', 0.7);

  const qty = /\b(?:Quantity|QTY)\s*[:#]?\s*(\d[\d,]*)/i.exec(lines.join('\n'));
  if (qty) out.quantity = field(qty[1].replace(/,/g, ''), 'ocr', 0.8);
  else {
    const qIdx = lines.findIndex((l) => /^(Quantity|QTY)\s*$/i.test(l));
    if (qIdx >= 0 && /^\d[\d,]*$/.test(lines[qIdx + 1] ?? '')) out.quantity = field(lines[qIdx + 1].replace(/,/g, ''), 'ocr', 0.7);
  }

  const mfr = findManufacturer(lines.filter((l) => !/digi-?key|thief river/i.test(l)));
  if (mfr) out.manufacturer = field(mfr, 'ocr', 0.6);
  return out;
}

/**
 * ECIA / ISO-15434 2D label data ("[)>␞06␝P...␝1P...␝Q10␝..."), as printed in DigiKey and Mouser DataMatrix codes.
 * Field identifiers: P = customer/supplier part, 1P = manufacturer part, Q = quantity, 1T = lot, 4L = country.
 */
export function parseEcia(data: string): { p?: string; mpn?: string; qty?: string } | undefined {
  if (!data.startsWith('[)>')) return undefined;
  const parts = data.split(/[\x1d\x1e]|\{GS\}|\{RS\}/).map((s) => s.replace(/\x04$/, ''));
  const out: { p?: string; mpn?: string; qty?: string } = {};
  for (const p of parts) {
    if (/^1P/.test(p)) out.mpn = p.slice(2);
    else if (/^P/.test(p) && !out.p) out.p = p.slice(1);
    else if (/^Q\d+$/.test(p)) out.qty = p.slice(1);
  }
  return out;
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** OCR-insensitive comparison: O/0, I/1/l, S/5, B/8 look alike. */
function ocrKey(s: string): string {
  return s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/\s/g, '');
}

// ---------- barcode-to-field assignment ----------
// A decoded barcode is only used for a field when we can show it belongs there:
//  * ECIA 2D data names its fields (P, 1P, Q), or
//  * it sits directly under the OCR'd field caption ("Mouser P/N", "MFG P/N", "QTY"), or
//  * its content proves it (Mouser SKU format + the MPN barcode right below shares its stem), or
//  * it matches what OCR read for that field (within OCR-typical errors).
// Anything else is offered to the member as an unassigned barcode instead of being guessed into a field.

const MOUSER_SKU_RE = /^\d{2,3}-[A-Z0-9][A-Z0-9\-,./#+()]{2,}$/;
const DK_SKU_RE = /^[0-9A-Z][0-9A-Z\-./#]{1,}-ND$/;

/** Alphanumeric core used to compare a SKU with an MPN: "771-74LVC244APW-T" -> "74LVC244APWT". */
function stem(s: string): string {
  return s.toUpperCase().replace(/^\d{2,3}-/, '').replace(/[^A-Z0-9]/g, '');
}
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
/** SKU and MPN describe the same part when their alphanumeric stems agree for at least 5 characters. */
export function stemsAgree(sku: string, mpn: string): boolean {
  const a = ocrKey(stem(sku)), b = ocrKey(stem(mpn));
  return a.length >= 5 && b.length >= 5 && commonPrefix(a, b) >= Math.min(5, a.length, b.length);
}
function ocrClose(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 6) return false;
  return levenshtein(ocrKey(a), ocrKey(b)) <= Math.max(2, Math.floor(a.length * 0.15));
}

const hasPos = (b: BarcodeHit) => b.y0 !== undefined && b.y1 !== undefined;

/** The OCR caption line just above a barcode (field captions are printed directly over their barcode). */
function captionAbove(b: BarcodeHit, lines: OcrLine[]): string | undefined {
  if (!hasPos(b) || !lines.length) return undefined;
  const bh = b.y1! - b.y0!;
  const bc = (b.y0! + b.y1!) / 2;
  let best: { l: OcrLine; c: number } | undefined;
  for (const l of lines) {
    const lh = Math.max(8, l.y1 - l.y0);
    const lc = (l.y0 + l.y1) / 2;
    const overlapX = Math.min(b.x1 ?? Infinity, l.x1) - Math.max(b.x0 ?? -Infinity, l.x0);
    // Caption centre is above the barcode centre and close to the barcode top. Tesseract's line boxes on real
    // bags are often tall and overlap the bars, so compare centres rather than edges. Nearest caption wins.
    if (lc < bc && b.y0! - lc < Math.max(lh, bh) * 1.8 && overlapX > 0) {
      if (!best || lc > best.c) best = { l, c: lc };
    }
  }
  return best?.l.text;
}

const CAPTION = {
  mouserSku: /m\W?o\W?u\W?s\W?e\W?r|ouser|mous/i,
  mfg: /\b(m\W?f\W?g|mfr|nfg|mf6|m[f£]g)\b/i,
  qty: /\b(q\W?t\W?y|qty|0ty|oty|qy)\b/i,
};

function assignMouser(out: LabelFields, linear: BarcodeHit[], lines: OcrLine[], ocr: { sku?: string; mpn?: string; qty?: string }) {
  const used = new Set<BarcodeHit>();
  const cap = (b: BarcodeHit) => captionAbove(b, lines) ?? '';

  // SKU: Mouser format, and one of: caption, MPN-stem partner, OCR agreement. Must be unique.
  const skuCands = linear.filter((b) => MOUSER_SKU_RE.test(b.text));
  const mpnLike = (b: BarcodeHit) => !MOUSER_SKU_RE.test(b.text) && /[A-Z]/i.test(b.text) && /\d/.test(b.text) && b.text.length >= 4;
  const below = (a: BarcodeHit, b: BarcodeHit) => hasPos(a) && hasPos(b) && b.y0! > a.y0! && b.y0! - a.y1! < (a.y1! - a.y0!) * 4;
  let skuHit: BarcodeHit | undefined, skuWhy = '';
  for (const b of skuCands) {
    const partner = linear.find((m) => mpnLike(m) && stemsAgree(b.text, m.text) && (!hasPos(b) || below(b, m)));
    const why = CAPTION.mouserSku.test(cap(b)) ? 'barcode under "Mouser P/N"'
      : partner ? `barcode whose part stem matches the MFG P/N barcode (${partner.text})`
      : ocr.sku && ocrClose(b.text, ocr.sku) ? 'barcode matches OCR of Mouser P/N' : '';
    if (why) { if (skuHit && skuHit.text !== b.text) { skuHit = undefined; break; } skuHit = b; skuWhy = why; }
  }
  if (skuHit) { out.sku = { value: skuHit.text, source: 'barcode', confidence: 1, verifiedBy: skuWhy }; used.add(skuHit); }

  // MPN: caption "MFG P/N", or stem partner of the verified SKU sitting below it, or OCR agreement.
  const mpnCands = linear.filter((b) => !used.has(b) && b.text.length >= 3 && !MOUSER_SKU_RE.test(b.text));
  const mpnWhys = mpnCands.map((b) => {
    if (CAPTION.mfg.test(cap(b)) && !/^\d{1,6}$/.test(b.text)) return 'barcode under "MFG P/N"';
    if (skuHit && mpnLike(b) && stemsAgree(skuHit.text, b.text) && (!hasPos(b) || below(skuHit, b))) return 'barcode below the Mouser P/N with the same part stem';
    if (ocr.mpn && ocrClose(b.text, ocr.mpn)) return 'barcode matches OCR of MFG P/N';
    return '';
  });
  const mpnOk = mpnCands.filter((_, i) => mpnWhys[i]);
  if (new Set(mpnOk.map((b) => b.text)).size === 1) {
    const b = mpnOk[0];
    out.mpn = { value: b.text, source: 'barcode', confidence: 1, verifiedBy: mpnWhys[mpnCands.indexOf(b)] };
    used.add(b);
  }

  // QTY: digits under a QTY caption, or equal to OCR'd QTY, or the first digits-only barcode right under the MPN barcode
  // (fixed Mouser layout: Mouser P/N, MFG P/N, then QTY).
  const mpnHit = mpnOk.length ? mpnOk[0] : undefined;
  const qtyCands = linear.filter((b) => !used.has(b) && /^\d{1,6}$/.test(b.text));
  const qtyByCap = qtyCands.find((b) => CAPTION.qty.test(cap(b)));
  const qtyByOcr = ocr.qty ? qtyCands.find((b) => b.text === ocr.qty) : undefined;
  const qtyByLayout = mpnHit && hasPos(mpnHit) ? qtyCands.filter((b) => hasPos(b) && b.y0! > mpnHit.y1! && b.y0! - mpnHit.y1! < (mpnHit.y1! - mpnHit.y0!) * 5).sort((a, b) => a.y0! - b.y0!)[0] : undefined;
  const q = qtyByCap ?? qtyByOcr ?? qtyByLayout;
  if (q) {
    out.quantity = { value: q.text, source: 'barcode', confidence: 1, verifiedBy: q === qtyByCap ? 'barcode under "QTY"' : q === qtyByOcr ? 'barcode matches OCR of QTY' : 'first number barcode under the MFG P/N' };
    used.add(q);
  }
  return used;
}

function assignDigikey(out: LabelFields, linear: BarcodeHit[], ocr: { sku?: string; mpn?: string; qty?: string }) {
  const used = new Set<BarcodeHit>();
  const skus = [...new Set(linear.filter((b) => DK_SKU_RE.test(b.text)).map((b) => b.text))];
  if (skus.length === 1) {
    const b = linear.find((x) => x.text === skus[0])!;
    out.sku = { value: b.text, source: 'barcode', confidence: 1, verifiedBy: 'DigiKey "-ND" barcode' };
    used.add(b);
  }
  if (ocr.mpn) {
    const b = linear.find((x) => !used.has(x) && ocrClose(x.text, ocr.mpn!));
    if (b) { out.mpn = { value: b.text, source: 'barcode', confidence: 1, verifiedBy: 'barcode matches OCR of MPN' }; used.add(b); }
  }
  if (ocr.qty) {
    const b = linear.find((x) => !used.has(x) && x.text === ocr.qty);
    if (b) { out.quantity = { value: b.text, source: 'barcode', confidence: 1, verifiedBy: 'barcode matches OCR of quantity' }; used.add(b); }
  }
  return used;
}

/** OCR part numbers are only auto-filled when they pass format checks; otherwise they become hints. */
function judgeOcr(out: LabelFields, supplier: Supplier | undefined) {
  const guesses: { sku?: string; mpn?: string } = {};
  const sku = out.sku?.source === 'ocr' ? out.sku : undefined;
  const mpn = out.mpn?.source === 'ocr' ? out.mpn : undefined;
  const plausibleMpn = (v: string) => v.length >= 4 && /\d/.test(v) && /[A-Z0-9]/.test(v) && !/[a-z]{2,}/.test(v) && !/[a-z]\d|\d[a-z]{2}/.test(v);
  if (supplier === 'mouser') {
    const skuOk = !!sku && MOUSER_SKU_RE.test(sku.value);
    const mpnOk = !!mpn && plausibleMpn(mpn.value);
    const barcodeSku = out.sku?.source === 'barcode' ? out.sku.value : undefined;
    const barcodeMpn = out.mpn?.source === 'barcode' ? out.mpn.value : undefined;
    // An OCR value is trusted when the other identifier (OCR or barcode) has the same part stem.
    const skuTrusted = skuOk && ((mpnOk && stemsAgree(sku!.value, mpn!.value)) || (!!barcodeMpn && stemsAgree(sku!.value, barcodeMpn)));
    const mpnTrusted = mpnOk && ((skuOk && stemsAgree(sku!.value, mpn!.value)) || (!!barcodeSku && stemsAgree(barcodeSku, mpn!.value)));
    if (sku && !skuTrusted) { guesses.sku = sku.value; out.sku = undefined; }
    else if (sku) sku.verifiedBy = 'OCR; SKU and MFG P/N agree';
    if (mpn && !mpnTrusted) { guesses.mpn = mpn.value; out.mpn = undefined; }
    else if (mpn) mpn.verifiedBy = 'OCR; SKU and MFG P/N agree';
  } else if (supplier === 'digikey') {
    if (sku && !DK_SKU_RE.test(sku.value)) { guesses.sku = sku.value; out.sku = undefined; }
    if (mpn && !plausibleMpn(mpn.value)) { guesses.mpn = mpn.value; out.mpn = undefined; }
  }
  if (guesses.sku || guesses.mpn) out.guesses = guesses;
}

export function parseLabel(text: string, barcodes: (string | BarcodeHit)[] = [], supplierOverride?: Supplier, lines: OcrLine[] = []): LabelFields {
  const hits: BarcodeHit[] = barcodes.map((b) => (typeof b === 'string' ? { text: b } : b)).filter((b) => b && typeof b.text === 'string' && b.text.trim());
  hits.forEach((b) => { b.text = b.text.trim(); });
  const detected = supplierOverride ? { value: supplierOverride, reason: 'chosen by user' } : detectSupplier(text, hits.map((b) => b.text));
  const supplier = detected?.value;
  let out: LabelFields = supplier === 'digikey' ? parseDigikeyText(text) : supplier === 'mouser' ? parseMouserText(text) : {};
  if (!supplier) {
    const m = parseMouserText(text), d = parseDigikeyText(text);
    out = { sku: m.sku ?? d.sku, mpn: m.mpn ?? d.mpn, quantity: m.quantity ?? d.quantity, description: m.description ?? d.description, manufacturer: m.manufacturer ?? d.manufacturer };
  }
  if (detected) out.supplier = detected;
  const ocr = { sku: out.sku?.value, mpn: out.mpn?.value, qty: out.quantity?.value };

  // ECIA 2D codes name their own fields, so they are always trusted.
  const linear: BarcodeHit[] = [];
  for (const b of hits) {
    const ecia = parseEcia(b.text);
    if (!ecia) { linear.push(b); continue; }
    if (ecia.mpn) out.mpn = { value: ecia.mpn, source: 'barcode', confidence: 1, verifiedBy: '2D code field 1P' };
    if (ecia.qty) out.quantity = { value: ecia.qty, source: 'barcode', confidence: 1, verifiedBy: '2D code field Q' };
    if (ecia.p && (DK_SKU_RE.test(ecia.p) ? supplier !== 'mouser' : supplier === 'mouser' && MOUSER_SKU_RE.test(ecia.p))) {
      out.sku = { value: ecia.p, source: 'barcode', confidence: 1, verifiedBy: '2D code field P' };
    }
  }

  const used = supplier === 'digikey' ? assignDigikey(out, linear, ocr) : assignMouser(out, linear, lines, ocr);
  judgeOcr(out, supplier);
  const rest = [...new Set(linear.filter((b) => !used.has(b)).map((b) => b.text))].filter((t) => t !== out.sku?.value && t !== out.mpn?.value);
  if (rest.length) out.unassigned = rest;
  out.partNumberStatus = out.sku || out.mpn ? 'ok' : 'unreadable';
  return out;
}
