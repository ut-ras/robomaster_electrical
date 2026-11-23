// Catalog providers (live or demo) and the identify step: SKU lookup, label cross-check, gap fill.

import type { CandidateMatch, CatalogPart, IdentifyResult, Supplier } from '../../shared/types.ts';
import { detectCategory, hasKey, isFromDescription, summaryKeys } from '../../shared/specs.ts';
import { mouserSearch, normalizeMouser, type MouserApiPart } from './mouser.ts';
import { digikeyDetails, normalizeDigikey, type DigikeyApiProduct } from './digikey.ts';
import { DIGIKEY_FIXTURES, MOUSER_FIXTURES } from './fixtures.ts';

export interface CatalogProvider {
  supplier: Supplier;
  mode: 'live' | 'demo';
  /** Look up by this supplier's SKU or by a manufacturer part number. */
  lookup(partNumber: string): Promise<CatalogPart[]>;
}

export class DemoMouser implements CatalogProvider {
  supplier = 'mouser' as const;
  mode = 'demo' as const;
  parts: MouserApiPart[];
  constructor(parts: MouserApiPart[] = MOUSER_FIXTURES) { this.parts = parts; }
  async lookup(pn: string) {
    const u = pn.trim().toUpperCase();
    return this.parts
      .filter((p) => p.MouserPartNumber.toUpperCase() === u || p.ManufacturerPartNumber.toUpperCase() === u)
      .map((p) => normalizeMouser(p, 'demo'));
  }
}

export class DemoDigikey implements CatalogProvider {
  supplier = 'digikey' as const;
  mode = 'demo' as const;
  parts: DigikeyApiProduct[];
  constructor(parts: DigikeyApiProduct[] = DIGIKEY_FIXTURES) { this.parts = parts; }
  async lookup(pn: string) {
    const u = pn.trim().toUpperCase();
    return this.parts
      .filter((p) => p.ManufacturerProductNumber.toUpperCase() === u || (p.ProductVariations ?? []).some((v) => v.DigiKeyProductNumber.toUpperCase() === u))
      .map((p) => normalizeDigikey(p, /-ND$/i.test(pn) ? pn.trim() : undefined, 'demo'));
  }
}

export class LiveMouser implements CatalogProvider {
  supplier = 'mouser' as const;
  mode = 'live' as const;
  key: string;
  constructor(key: string) { this.key = key; }
  lookup(pn: string) { return mouserSearch(pn, this.key, true); }
}

export class LiveDigikey implements CatalogProvider {
  supplier = 'digikey' as const;
  mode = 'live' as const;
  id: string; secret: string;
  constructor(id: string, secret: string) { this.id = id; this.secret = secret; }
  lookup(pn: string) { return digikeyDetails(pn, this.id, this.secret); }
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Record<Supplier, CatalogProvider> {
  return {
    mouser: env.MOUSER_API_KEY ? new LiveMouser(env.MOUSER_API_KEY) : new DemoMouser(),
    digikey: env.DIGIKEY_CLIENT_ID && env.DIGIKEY_CLIENT_SECRET ? new LiveDigikey(env.DIGIKEY_CLIENT_ID, env.DIGIKEY_CLIENT_SECRET) : new DemoDigikey(),
  };
}

// ---------- matching ----------

const BRANDS = ['nexperia', 'texas instruments', 'molex', 'tdk', 'murata', 'kemet', 'yageo', 'vishay', 'samsung', 'panasonic', 'avx', 'bourns',
  'te connectivity', 'amphenol', 'jst', 'wurth', 'microchip', 'stmicroelectronics', 'analog devices', 'onsemi', 'infineon', 'nxp', 'diodes',
  'littelfuse', 'coilcraft', 'sullins', 'harwin', 'hirose', 'taiyo yuden', 'stackpole', 'rohm'];
const ALIASES: Record<string, string> = { epcos: 'tdk', ti: 'texas instruments', 'on semiconductor': 'onsemi', 'würth': 'wurth', 'kyocera avx': 'avx', 'st': 'stmicroelectronics' };

/** "EPCOS - TDK Electronics" / "TDK ELECTRONICS INC" -> "tdk"; "Nexperia USA Inc." -> "nexperia". */
export function manufacturerKey(name: string): string {
  let s = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[.,()]/g, ' ').replace(/\b(inc|corp|corporation|llc|ltd|co|gmbh|ag|usa|america|americas|electronics|electronic|components|semiconductors?|technology|group|international)\b/g, ' ').replace(/\s+/g, ' ').trim();
  for (const b of BRANDS) if (new RegExp(`(^|\\W)${b}(\\W|$)`).test(s)) return b;
  for (const [a, b] of Object.entries(ALIASES)) if (new RegExp(`(^|\\W)${a}(\\W|$)`).test(s)) return b;
  return s;
}

/** Exact part-number identity: punctuation and leading zeros are significant; only case and outer spaces are not. */
export function sameMpn(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

export interface IdentifyInput { supplier: Supplier; sku?: string; mpn?: string; manufacturer?: string }

export async function identify(input: IdentifyInput, providers: Record<Supplier, CatalogProvider>): Promise<IdentifyResult> {
  const primary = providers[input.supplier];
  const other = providers[input.supplier === 'mouser' ? 'digikey' : 'mouser'];
  const reasons: string[] = [];
  let found: CatalogPart[] = [];
  if (input.sku) found = await primary.lookup(input.sku);
  if (!found.length && input.mpn) {
    if (input.sku) reasons.push(`${input.supplier} SKU ${input.sku} not found; searched by manufacturer part number instead`);
    found = await primary.lookup(input.mpn);
  }
  if (!found.length) {
    return { status: 'not_found', reasons: [...reasons, `No ${input.supplier} catalog match for ${input.sku ?? input.mpn ?? '(nothing entered)'}`], candidates: [] };
  }

  const candidates: CandidateMatch[] = found.map((part) => ({
    part,
    skuMatch: !!input.sku && [part.sku, ...part.altSkus].some((s) => s.toUpperCase() === input.sku!.trim().toUpperCase()),
    mpnMatch: input.mpn ? sameMpn(part.mpn, input.mpn) : null,
    manufacturerMatch: input.manufacturer ? manufacturerKey(part.manufacturer) === manufacturerKey(input.manufacturer) : null,
  }));

  const good = candidates.filter((c) => (c.skuMatch || !input.sku) && c.mpnMatch !== false && c.manufacturerMatch !== false);
  for (const c of candidates) {
    if (c.mpnMatch === false) reasons.push(`Catalog MPN "${c.part.mpn}" differs from label "${input.mpn}"`);
    if (c.manufacturerMatch === false) reasons.push(`Catalog manufacturer "${c.part.manufacturer}" differs from label "${input.manufacturer}"`);
  }
  if (found.length > 1) reasons.push(`${found.length} catalog variants matched; pick the exact one`);

  const result: IdentifyResult = { status: 'review', reasons, candidates };
  if (good.length === 1 && found.length === 1) {
    result.status = 'matched';
    result.chosen = await fillGaps(good[0].part, other, result);
  } else if (good.length === 1) {
    result.chosen = good[0].part; // pre-selected but still needs a human to confirm
  }
  return result;
}

/** Ask the other catalog only for missing summary specs or links; accept it only on exact manufacturer + MPN. */
export async function fillGaps(part: CatalogPart, other: CatalogProvider, result: IdentifyResult): Promise<CatalogPart> {
  const category = detectCategory(part.category, part.description);
  // Values read from a description don't count as present: an exact structured match from the other catalog outranks them.
  const structured = part.specs.filter((s) => !isFromDescription(s));
  const missing = summaryKeys(category).filter((k) => !hasKey(structured, k));
  if (!missing.length && part.datasheetUrl) return part;
  let found: CatalogPart[];
  try { found = await other.lookup(part.mpn); } catch (e) {
    result.gapFill = { supplier: other.supplier, addedKeys: [], rejected: `lookup failed: ${(e as Error).message}` };
    return part;
  }
  const exact = found.filter((p) => sameMpn(p.mpn, part.mpn) && manufacturerKey(p.manufacturer) === manufacturerKey(part.manufacturer));
  if (exact.length !== 1) {
    result.gapFill = { supplier: other.supplier, addedKeys: [], rejected: found.length ? 'no exact manufacturer + MPN match' : 'not listed' };
    return part;
  }
  const extra = exact[0];
  const have = new Set(structured.map((s) => s.key ?? s.name));
  const added = extra.specs.filter((s) => !have.has(s.key ?? s.name));
  result.gapFill = { supplier: other.supplier, addedKeys: [...new Set(added.map((s) => s.key ?? s.name))] };
  result.crossSku = { supplier: extra.supplier, sku: extra.sku };
  return {
    ...part,
    datasheetUrl: part.datasheetUrl ?? extra.datasheetUrl,
    specs: [...part.specs, ...added],
  };
}
