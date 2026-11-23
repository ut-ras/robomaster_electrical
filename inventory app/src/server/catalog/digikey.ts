// DigiKey Product Information API v4, ProductDetails endpoint, using OAuth2 client credentials.
// Needs DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET from a production app on developer.digikey.com.

import type { CatalogPart } from '../../shared/types.ts';
import { makeSpec } from '../../shared/specs.ts';

export interface DigikeyApiProduct {
  ManufacturerProductNumber: string;
  Manufacturer: { Id?: number; Name: string };
  Description?: { ProductDescription?: string; DetailedDescription?: string };
  ProductUrl?: string;
  DatasheetUrl?: string;
  Category?: { Name: string; ChildCategories?: { Name: string; ChildCategories?: unknown[] }[] };
  Parameters?: { ParameterId?: number; ParameterText: string; ValueId?: string; ValueText: string }[];
  ProductVariations?: { DigiKeyProductNumber: string; PackageType?: { Name?: string } }[];
  Series?: { Name?: string };
}

export interface DigikeyApiResponse { Product?: DigikeyApiProduct }

function deepestCategory(c?: DigikeyApiProduct['Category']): string {
  let name = c?.Name ?? '';
  let kids = c?.ChildCategories;
  while (kids && kids.length) {
    const k = kids[0] as { Name: string; ChildCategories?: unknown[] };
    name = `${name} > ${k.Name}`;
    kids = k.ChildCategories as typeof kids;
  }
  return name;
}

/** `requestedSku` is the SKU from the bag, so we report it as the SKU when it is one of the variations. */
export function normalizeDigikey(p: DigikeyApiProduct, requestedSku: string | undefined, origin: 'live' | 'demo'): CatalogPart {
  const skus = (p.ProductVariations ?? []).map((v) => v.DigiKeyProductNumber);
  const sku = requestedSku && skus.some((s) => s.toUpperCase() === requestedSku.toUpperCase())
    ? skus.find((s) => s.toUpperCase() === requestedSku.toUpperCase())!
    : skus[0] ?? requestedSku ?? '';
  const url = p.ProductUrl || undefined;
  const specs = (p.Parameters ?? [])
    .filter((x) => x.ParameterText)
    .map((x) => makeSpec(x.ParameterText, x.ValueText ?? '', 'digikey', { sourceRef: url }));
  if (p.Series?.Name && p.Series.Name !== '-') specs.unshift(makeSpec('Series', p.Series.Name, 'digikey', { sourceRef: url }));
  return {
    supplier: 'digikey',
    sku,
    altSkus: skus.filter((s) => s !== sku),
    manufacturer: p.Manufacturer?.Name ?? '',
    mpn: p.ManufacturerProductNumber,
    description: p.Description?.DetailedDescription || p.Description?.ProductDescription || '',
    category: deepestCategory(p.Category),
    productUrl: url,
    datasheetUrl: p.DatasheetUrl || undefined,
    specs,
    origin,
  };
}

let token: { value: string; expires: number } | undefined;

async function getToken(clientId: string, secret: string): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetch('https://api.digikey.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`DigiKey OAuth HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return token.value;
}

/** ProductDetails accepts either a DigiKey SKU or a manufacturer part number. 404 -> []. */
export async function digikeyDetails(productNumber: string, clientId: string, secret: string): Promise<CatalogPart[]> {
  const bearer = await getToken(clientId, secret);
  const res = await fetch(`https://api.digikey.com/products/v4/search/${encodeURIComponent(productNumber)}/productdetails`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      'X-DIGIKEY-Client-Id': clientId,
      'X-DIGIKEY-Locale-Site': 'US',
      'X-DIGIKEY-Locale-Language': 'en',
      'X-DIGIKEY-Locale-Currency': 'USD',
      Accept: 'application/json',
    },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`DigiKey API HTTP ${res.status}`);
  const json = (await res.json()) as DigikeyApiResponse;
  if (!json.Product) return [];
  const requested = /-ND$/i.test(productNumber) ? productNumber : undefined;
  return [normalizeDigikey(json.Product, requested, 'live')];
}
