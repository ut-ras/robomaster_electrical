// Shared domain types. Used by the server and (type-stripped) by the browser client.

export type Supplier = 'mouser' | 'digikey';
export type SpecSource = 'mouser' | 'digikey' | 'manual' | 'label';
export type Category = 'capacitor' | 'resistor' | 'inductor' | 'ic' | 'connector' | 'other';

/** Percent or absolute tolerance. Asymmetric values keep both sides. Absolute values are in SI base units. */
export interface Tolerance {
  kind: 'percent' | 'absolute';
  minus: number; // magnitude, always >= 0
  plus: number; // magnitude, always >= 0
  unit?: string; // for absolute tolerances, e.g. 'F'
}

export interface Spec {
  /** Attribute name exactly as the source printed it, e.g. "Voltage - Rated". */
  name: string;
  /** Value exactly as the source printed it, e.g. "-20%, +80%". Never rewritten. */
  value: string;
  /** Canonical unit parsed from the value (F, Ω, H, V, A, W, Hz, m, %, °C, ppm/°C) when one is found. */
  unit?: string;
  /** Canonical key used for summaries and parametric search (capacitance, voltage_rated, ...). */
  key?: string;
  /** Parsed nominal value in SI base units. */
  num?: number;
  min?: number;
  max?: number;
  tol?: Tolerance;
  /** Test condition such as "@ 100kHz" or "(25°C)". */
  condition?: string;
  source: SpecSource;
  /** Datasheet page, product URL, or note proving a manual value. */
  sourceRef?: string;
  verified?: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export interface CatalogPart {
  supplier: Supplier;
  sku: string;
  /** Other SKUs the same catalog record lists (e.g. DigiKey cut tape / reel variations). */
  altSkus: string[];
  manufacturer: string;
  mpn: string;
  description: string;
  category: string;
  productUrl?: string;
  datasheetUrl?: string;
  specs: Spec[];
  /** "live" when fetched from the real API in this request, "demo" when served from bundled fixtures. */
  origin: 'live' | 'demo';
}

export interface FieldValue {
  value: string;
  source: 'ocr' | 'barcode' | 'manual';
  /** 0..1 rough confidence. */
  confidence: number;
  /** Why we believe this value belongs to this field, e.g. "barcode under 'Mouser P/N'". */
  verifiedBy?: string;
}

/** A decoded barcode with its position in the photo (pixels). Position is optional for typed-in test data. */
export interface BarcodeHit { text: string; format?: string; x0?: number; y0?: number; x1?: number; y1?: number }

/** One OCR text line with its bounding box in the same pixel space as the barcodes. */
export interface OcrLine { text: string; x0: number; y0: number; x1: number; y1: number }

export interface LabelFields {
  supplier?: { value: Supplier; reason: string };
  sku?: FieldValue;
  mpn?: FieldValue;
  manufacturer?: FieldValue;
  description?: FieldValue;
  quantity?: FieldValue;
  /** 'unreadable' when neither the SKU nor the MPN could be read reliably. */
  partNumberStatus?: 'ok' | 'unreadable';
  /** OCR text that looked like a part number but could not be confirmed; shown as a hint, never auto-filled. */
  guesses?: { sku?: string; mpn?: string };
  /** Decoded barcodes we could not tie to a field; the member can assign them with one tap. */
  unassigned?: string[];
}

export interface IdentifyResult {
  status: 'matched' | 'review' | 'not_found';
  reasons: string[];
  candidates: CandidateMatch[];
  /** The candidate we would save if the user confirms, with gaps filled from the other catalog. */
  chosen?: CatalogPart;
  /** SKU of the other supplier that verified-matched during gap fill, if any. */
  crossSku?: { supplier: Supplier; sku: string };
  gapFill?: { supplier: Supplier; addedKeys: string[]; rejected?: string };
}

export interface CandidateMatch {
  part: CatalogPart;
  skuMatch: boolean;
  mpnMatch: boolean | null; // null when the label had no MPN
  manufacturerMatch: boolean | null;
}

export interface InventoryPart {
  partId: string;
  manufacturer: string;
  mpn: string;
  category: Category;
  description: string;
  datasheetUrl?: string;
  productUrl?: string;
  skus: { supplier: Supplier; sku: string; onLabel: boolean }[];
  locations: { drawer: string; qty: number | null }[];
  specs: Spec[];
}
