// Mouser Search API v1 (https://api.mouser.com/api/docs/ui/index). Needs MOUSER_API_KEY (Search API key).

import type { CatalogPart } from '../../shared/types.ts';
import { makeSpec, specsFromDescription } from '../../shared/specs.ts';

export interface MouserApiPart {
  MouserPartNumber: string;
  ManufacturerPartNumber: string;
  Manufacturer: string;
  Description?: string;
  Category?: string;
  DataSheetUrl?: string;
  ProductDetailUrl?: string;
  ProductAttributes?: { AttributeName: string; AttributeValue: string }[];
}

export interface MouserApiResponse {
  Errors?: { Message?: string }[];
  SearchResults?: { NumberOfResult: number; Parts: MouserApiPart[] } | null;
}

export function normalizeMouser(p: MouserApiPart, origin: 'live' | 'demo'): CatalogPart {
  const url = p.ProductDetailUrl || undefined;
  const specs = (p.ProductAttributes ?? [])
    .filter((a) => a.AttributeName && a.AttributeValue !== undefined)
    .map((a) => makeSpec(a.AttributeName, String(a.AttributeValue), 'mouser', { sourceRef: url }));
  // Mouser often lists a resistor's ratings only in the description; read them for keys the attributes lack.
  const have = new Set(specs.map((s) => s.key).filter((k): k is string => !!k));
  specs.push(...specsFromDescription(p.Description ?? '', p.Category ?? '', 'mouser', have));
  return {
    supplier: 'mouser',
    sku: p.MouserPartNumber,
    altSkus: [],
    manufacturer: p.Manufacturer,
    mpn: p.ManufacturerPartNumber,
    description: p.Description ?? '',
    category: p.Category ?? '',
    productUrl: url,
    datasheetUrl: p.DataSheetUrl || undefined,
    specs,
    origin,
  };
}

/** Search by Mouser part number or manufacturer part number. Returns every part Mouser lists. */
export async function mouserSearch(partNumber: string, apiKey: string, exact = true): Promise<CatalogPart[]> {
  const res = await fetch(`https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: partNumber, partSearchOptions: exact ? 'Exact' : 'None' } }),
  });
  if (!res.ok) throw new Error(`Mouser API HTTP ${res.status}`);
  const json = (await res.json()) as MouserApiResponse;
  if (json.Errors?.length) throw new Error(`Mouser API: ${json.Errors.map((e) => e.Message).join('; ')}`);
  return (json.SearchResults?.Parts ?? []).map((p) => normalizeMouser(p, 'live'));
}
