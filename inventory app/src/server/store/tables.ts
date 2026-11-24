// Tab layout of the shared Google Sheet, and a tiny row-store interface with two backends:
// SheetsStore (live Google Sheets API) and FileStore (local JSON file with the same tabs, for demos/tests).

export const TABS = {
  parts: { name: 'Parts', header: ['part_id', 'manufacturer', 'mpn', 'category', 'description', 'datasheet_url', 'product_url', 'created_by', 'created_at', 'updated_at'] },
  skus: { name: 'Supplier SKUs', header: ['supplier', 'sku', 'part_id', 'on_label', 'product_url', 'added_by', 'added_at'] },
  specs: { name: 'Specs', header: ['part_id', 'key', 'name', 'value', 'unit', 'num', 'min', 'max', 'tol_kind', 'tol_minus', 'tol_plus', 'condition', 'source', 'source_ref', 'verified', 'updated_by', 'updated_at'] },
  locations: { name: 'Locations', header: ['part_id', 'drawer', 'added_by', 'added_at', 'request_id'] },
  ledger: { name: 'Stock Ledger', header: ['entry_id', 'request_id', 'part_id', 'drawer', 'delta', 'member', 'timestamp', 'reason', 'note'] },
} as const;

export type TabId = keyof typeof TABS;
export type Cell = string | number | boolean;
export type Row = Record<string, string>;

export interface TableStore {
  readonly mode: 'sheets' | 'file';
  /** Link people can open to view the data directly (Google Sheets only). */
  readonly viewUrl?: string;
  ensureTabs(): Promise<void>;
  /** All data rows (header excluded) as objects keyed by header name. Values are strings. */
  read(tab: TabId): Promise<Row[]>;
  append(tab: TabId, rows: Row[]): Promise<void>;
  /** index is the 0-based data-row index returned by read(). */
  update(tab: TabId, index: number, row: Row): Promise<void>;
}

export function toCells(tab: TabId, row: Row): string[] {
  return TABS[tab].header.map((h) => row[h] ?? '');
}

export function fromCells(tab: TabId, cells: unknown[]): Row {
  const out: Row = {};
  TABS[tab].header.forEach((h, i) => { out[h] = cells[i] === undefined || cells[i] === null ? '' : String(cells[i]); });
  return out;
}
