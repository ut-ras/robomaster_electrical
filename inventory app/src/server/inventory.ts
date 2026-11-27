// Inventory service on top of the row store. All writes go through one lock and are upserts keyed by
// deterministic ids, so a retried save is harmless. Stock changes are ledger rows deduplicated by request_id.

import { createHash, randomUUID } from 'node:crypto';
import type { CatalogPart, Category, InventoryPart, Spec, Supplier } from '../shared/types.ts';
import { detectCategory, makeSpec } from '../shared/specs.ts';
import { cleanHardwareSpecs, isHardwareCategory, normDrawer, UNASSIGNED_DRAWER, type ThreadSystem } from '../shared/hardware.ts';
import { manufacturerKey } from './catalog/index.ts';
import type { Row, TableStore } from './store/tables.ts';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) { super(message); this.status = status; this.details = details; }
}

/** One catalog record per manufacturer + full MPN. Case-insensitive, punctuation and leading zeros significant. */
export function partIdFor(manufacturer: string, mpn: string): string {
  const h = createHash('sha256').update(`${manufacturerKey(manufacturer)}\u0000${mpn.trim().toUpperCase()}`).digest('hex');
  return `P-${h.slice(0, 12)}`;
}

/**
 * Stable inventory id for hardware with no supplier part number, e.g. "HW-3F9A0C12". Derived from the save's
 * request id, so a retried save lands on the same part, and short enough to write on a bin label.
 */
export function looseIdFor(requestId: string): string {
  return `HW-${createHash('sha256').update(`loose\u0000${requestId}`).digest('hex').slice(0, 8).toUpperCase()}`;
}

/** Blank drawers become the part's single "Not specified" location (see normDrawer). */
const sameDrawer = (a: string, b: string) => normDrawer(a).toUpperCase() === normDrawer(b).toUpperCase();
const drawerWords = (d: string) => (normDrawer(d) === UNASSIGNED_DRAWER ? 'with no drawer' : `in ${normDrawer(d)}`);
const bool = (s: string) => /^(true|yes|1)$/i.test(s);

function specToRow(partId: string, s: Spec, member: string, now: string): Row {
  return {
    part_id: partId, key: s.key ?? '', name: s.name, value: s.value, unit: s.unit ?? '',
    num: s.num !== undefined ? String(s.num) : '', min: s.min !== undefined ? String(s.min) : '', max: s.max !== undefined ? String(s.max) : '',
    tol_kind: s.tol?.kind ?? '', tol_minus: s.tol ? String(s.tol.minus) : '', tol_plus: s.tol ? String(s.tol.plus) : '',
    condition: s.condition ?? '', source: s.source, source_ref: s.sourceRef ?? '', verified: s.verified ? 'TRUE' : 'FALSE',
    updated_by: s.updatedBy ?? member, updated_at: s.updatedAt ?? now,
  };
}

function rowToSpec(r: Row): Spec {
  // Re-parse from the original strings so search logic improvements apply to old rows too.
  const s = makeSpec(r.name, r.value, r.source as Spec['source'], {
    sourceRef: r.source_ref || undefined, verified: bool(r.verified), updatedBy: r.updated_by || undefined, updatedAt: r.updated_at || undefined,
  });
  if (r.key && !s.key) s.key = r.key;
  return s;
}

/**
 * One spec per source + name, because the Specs tab keys rows that way. A catalog that repeats an attribute
 * (Mouser lists "Packaging" once per option: Reel, Cut Tape, MouseReel) gets its values joined into one row;
 * for repeated manual entries the last one wins.
 */
export function oneSpecPerName(specs: Spec[]): Spec[] {
  const out = new Map<string, Spec>();
  for (const s of specs) {
    const k = `${s.source}\u0000${s.name}`;
    const prev = out.get(k);
    if (!prev || s.source === 'manual') { out.set(k, s); continue; }
    if (prev.value.split(', ').includes(s.value)) continue;
    out.set(k, makeSpec(prev.name, `${prev.value}, ${s.value}`, prev.source, { sourceRef: prev.sourceRef, verified: prev.verified, updatedBy: prev.updatedBy, updatedAt: prev.updatedAt }));
  }
  return [...out.values()];
}

export interface SaveRequest {
  requestId: string;
  member: string;
  drawer: string;
  part: CatalogPart; // the reviewed catalog match (possibly with user-corrected fields)
  labelSku?: { supplier: Supplier; sku: string };
  crossSku?: { supplier: Supplier; sku: string };
  /** Manual or corrected specs entered on the review screen (marked verified). */
  manualSpecs?: { name: string; value: string; sourceRef: string }[];
}

export interface HardwareSaveRequest {
  requestId: string;
  member: string;
  name: string;
  category: Category;
  supplier?: Supplier;
  /** Supplier part number, e.g. McMaster 31335A12. Optional: loose hardware gets an HW- id instead. */
  sku?: string;
  productUrl?: string;
  description?: string;
  threadSystem?: ThreadSystem;
  specs?: { name: string; value: string }[];
  /** Where the specs came from, e.g. "McMaster-Carr label". Defaults to the product link or the member. */
  specSource?: string;
  drawer?: string;
  /** Add to this existing part instead of creating one. */
  partId?: string;
}

export class Inventory {
  store: TableStore;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(store: TableStore) { this.store = store; }

  /** Serialise all writers in this process. (Run a single server instance per Sheet.) */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async loadAll(): Promise<InventoryPart[]> {
    const [parts, skus, specs, locs, ledger] = await Promise.all([
      this.store.read('parts'), this.store.read('skus'), this.store.read('specs'), this.store.read('locations'), this.store.read('ledger'),
    ]);
    const qty = new Map<string, number>();
    for (const l of ledger) {
      const k = `${l.part_id}\u0000${normDrawer(l.drawer).toUpperCase()}`;
      qty.set(k, (qty.get(k) ?? 0) + Number(l.delta || 0));
    }
    return parts.map((p) => ({
      partId: p.part_id,
      name: p.name || undefined,
      manufacturer: p.manufacturer,
      mpn: p.mpn,
      category: (p.category || 'other') as Category,
      description: p.description,
      datasheetUrl: p.datasheet_url || undefined,
      productUrl: p.product_url || undefined,
      skus: skus.filter((s) => s.part_id === p.part_id).map((s) => ({ supplier: s.supplier as Supplier, sku: s.sku, onLabel: bool(s.on_label) })),
      locations: locs.filter((l) => l.part_id === p.part_id).map((l) => {
        const q = qty.get(`${p.part_id}\u0000${normDrawer(l.drawer).toUpperCase()}`);
        return { drawer: l.drawer, qty: q === undefined ? null : q };
      }),
      specs: specs.filter((s) => s.part_id === p.part_id).map(rowToSpec),
    }));
  }

  async getPart(partId: string): Promise<InventoryPart | undefined> {
    return (await this.loadAll()).find((p) => p.partId === partId);
  }

  async findBySku(sku: string): Promise<InventoryPart | undefined> {
    const u = sku.trim().toUpperCase();
    return (await this.loadAll()).find((p) => p.skus.some((s) => s.sku.toUpperCase() === u));
  }

  /** Shares the writer lock with saves and stock changes. Repeating a completed delete is harmless. */
  deletePart(partId: string) {
    return this.locked(async () => {
      if (!/^(P-[0-9a-f]+|HW-[0-9A-F]+)$/.test(partId)) throw new HttpError(400, 'Invalid inventory ID');
      const part = (await this.store.read('parts')).find((p) => p.part_id === partId);
      await this.store.deleteByPartId(partId);
      return { partId, name: part?.name || part?.mpn || partId };
    });
  }

  save(req: SaveRequest) {
    return this.locked(async () => {
      const { part, member } = req;
      if (!part.manufacturer.trim() || !part.mpn.trim()) throw new HttpError(400, 'Manufacturer and manufacturer part number are required');
      const now = new Date().toISOString();
      const partId = partIdFor(part.manufacturer, part.mpn);
      const category = detectCategory(part.category, part.description);

      // Refuse to attach a SKU that already belongs to a different catalog record.
      const skus = await this.store.read('skus');
      const wanted = [req.labelSku && { ...req.labelSku, onLabel: true }, req.crossSku && { ...req.crossSku, onLabel: false }].filter(Boolean) as { supplier: Supplier; sku: string; onLabel: boolean }[];
      for (const w of wanted) {
        const clash = skus.find((s) => s.supplier === w.supplier && s.sku.toUpperCase() === w.sku.toUpperCase() && s.part_id !== partId);
        if (clash) throw new HttpError(409, `${w.supplier} SKU ${w.sku} is already linked to another part (${clash.part_id}). Review before saving.`, { partId: clash.part_id });
      }

      // Parts: upsert
      const parts = await this.store.read('parts');
      const pIdx = parts.findIndex((p) => p.part_id === partId);
      const partRow: Row = {
        part_id: partId, manufacturer: part.manufacturer, mpn: part.mpn, category, description: part.description,
        datasheet_url: part.datasheetUrl ?? '', product_url: part.productUrl ?? '', created_by: member, created_at: now, updated_at: now,
      };
      let created = false;
      if (pIdx < 0) { await this.store.append('parts', [partRow]); created = true; }
      else {
        const old = parts[pIdx];
        await this.store.update('parts', pIdx, { ...partRow, created_by: old.created_by, created_at: old.created_at, description: part.description || old.description, datasheet_url: partRow.datasheet_url || old.datasheet_url, product_url: partRow.product_url || old.product_url, name: old.name ?? '' });
      }

      // Supplier SKUs: add or upgrade to on_label
      const newSkus: Row[] = [];
      for (const w of wanted) {
        const i = skus.findIndex((s) => s.supplier === w.supplier && s.sku.toUpperCase() === w.sku.toUpperCase());
        if (i < 0) newSkus.push({ supplier: w.supplier, sku: w.sku, part_id: partId, on_label: w.onLabel ? 'TRUE' : 'FALSE', product_url: w.supplier === part.supplier ? part.productUrl ?? '' : '', added_by: member, added_at: now });
        else if (w.onLabel && !bool(skus[i].on_label)) await this.store.update('skus', i, { ...skus[i], on_label: 'TRUE' });
      }
      await this.store.append('skus', newSkus);

      // Specs
      const manual = (req.manualSpecs ?? []).filter((m) => m.name.trim() && m.value.trim()).map((m) =>
        makeSpec(m.name.trim(), m.value.trim(), 'manual', { sourceRef: m.sourceRef.trim(), verified: true, updatedBy: member, updatedAt: now }));
      await this.upsertSpecs(partId, [...part.specs, ...manual], member, now);

      await this.ensureLocation(partId, req.drawer, member, now, req.requestId);
      return { partId, created };
    });
  }

  /** One location per part and drawer; a blank drawer is the part's single "Not specified" location. */
  private async ensureLocation(partId: string, drawer: string | undefined, member: string, now: string, requestId: string) {
    const locs = await this.store.read('locations');
    if (locs.some((l) => l.part_id === partId && sameDrawer(l.drawer, drawer ?? ''))) return false;
    await this.store.append('locations', [{ part_id: partId, drawer: normDrawer(drawer), added_by: member, added_at: now, request_id: requestId }]);
    return true;
  }

  /**
   * Save mechanical hardware entered by hand or read from a McMaster-Carr label.
   * Identity: an existing part chosen by the member, else the supplier part number (McMaster parts use
   * manufacturer "McMaster-Carr" + their part number, like any MPN), else a stable HW- id for loose hardware.
   * Specs are member-entered ("manual", not verified); a later catalog or datasheet edit can verify them.
   */
  saveHardware(req: HardwareSaveRequest) {
    return this.locked(async () => {
      const name = String(req.name ?? '').trim().replace(/\s+/g, ' ');
      if (!name) throw new HttpError(400, 'Part name is required');
      if (!isHardwareCategory(req.category)) throw new HttpError(400, 'Choose a hardware category');
      const cleaned = cleanHardwareSpecs(req.category, req.threadSystem, req.specs ?? []);
      if ('error' in cleaned) throw new HttpError(400, cleaned.error);
      const sku = String(req.sku ?? '').trim().toUpperCase().replace(/\s+/g, '');
      const supplier = req.supplier;
      if (sku && !supplier) throw new HttpError(400, 'Choose the supplier for that part number');
      const now = new Date().toISOString();
      const parts = await this.store.read('parts');
      const skus = await this.store.read('skus');
      const linked = sku ? skus.find((s) => s.supplier === supplier && s.sku.toUpperCase() === sku) : undefined;

      let partId: string;
      if (req.partId) {
        if (!parts.some((p) => p.part_id === req.partId)) throw new HttpError(404, 'Unknown part');
        if (linked && linked.part_id !== req.partId) throw new HttpError(409, `${supplier} part ${sku} is already linked to another part (${linked.part_id}).`, { partId: linked.part_id });
        partId = req.partId;
      } else if (linked) partId = linked.part_id;
      else if (sku && supplier === 'mcmaster') partId = partIdFor('McMaster-Carr', sku);
      else if (sku) partId = partIdFor(`${supplier} part`, sku);
      else partId = looseIdFor(req.requestId);

      const pIdx = parts.findIndex((p) => p.part_id === partId);
      const row: Row = {
        part_id: partId, manufacturer: supplier === 'mcmaster' ? 'McMaster-Carr' : '', mpn: supplier === 'mcmaster' ? sku : '',
        category: req.category, description: String(req.description ?? '').trim(), datasheet_url: '', product_url: String(req.productUrl ?? '').trim(),
        created_by: req.member, created_at: now, updated_at: now, name,
      };
      let created = false;
      if (pIdx < 0) { await this.store.append('parts', [row]); created = true; }
      else {
        const old = parts[pIdx];
        await this.store.update('parts', pIdx, {
          ...old, category: row.category, name, updated_at: now,
          description: row.description || old.description, product_url: row.product_url || old.product_url,
          manufacturer: old.manufacturer || row.manufacturer, mpn: old.mpn || row.mpn,
        });
      }
      if (sku && !linked) {
        await this.store.append('skus', [{ supplier: supplier!, sku, part_id: partId, on_label: 'TRUE', product_url: row.product_url, added_by: req.member, added_at: now }]);
      }
      const ref = String(req.specSource ?? '').trim() || row.product_url || `Entered by ${req.member}`;
      await this.upsertSpecs(partId, cleaned.specs.map((s) => makeSpec(s.name, s.value, 'manual', { sourceRef: ref, updatedBy: req.member, updatedAt: now })), req.member, now);
      await this.ensureLocation(partId, req.drawer, req.member, now, req.requestId);
      return { partId, created };
    });
  }

  /** Add a drawer (or the unassigned location) to an existing part. */
  addLocation(partId: string, drawer: string, member: string, requestId: string) {
    return this.locked(async () => {
      if (!(await this.store.read('parts')).some((p) => p.part_id === partId)) throw new HttpError(404, 'Unknown part');
      return { added: await this.ensureLocation(partId, drawer, member, new Date().toISOString(), requestId) };
    });
  }

  /** Catalog specs are refreshed in place; rows a member verified are never overwritten by a refresh. */
  private async upsertSpecs(partId: string, specs: Spec[], member: string, now: string) {
    const rows = await this.store.read('specs');
    const toAppend: Row[] = [];
    for (const s of oneSpecPerName(specs)) {
      const i = rows.findIndex((r) => r.part_id === partId && r.source === s.source && r.name === s.name);
      const row = specToRow(partId, s, member, now);
      if (i < 0) { toAppend.push(row); rows.push(row); continue; }
      if (bool(rows[i].verified) && !s.verified) continue; // keep verified edit
      if (rows[i].value === row.value && rows[i].source_ref === row.source_ref && rows[i].verified === row.verified) continue;
      await this.store.update('specs', i, row);
      rows[i] = row;
    }
    await this.store.append('specs', toAppend);
  }

  refreshSpecs(partId: string, fresh: CatalogPart, member: string) {
    return this.locked(async () => {
      const now = new Date().toISOString();
      if (partIdFor(fresh.manufacturer, fresh.mpn) !== partId) throw new HttpError(409, 'Catalog returned a different manufacturer/MPN; not refreshing');
      await this.upsertSpecs(partId, fresh.specs, member, now);
    });
  }

  editSpec(partId: string, name: string, value: string, sourceRef: string, member: string) {
    if (!sourceRef.trim()) throw new HttpError(400, 'Manual specs need a datasheet page or source link');
    return this.locked(async () => {
      const now = new Date().toISOString();
      await this.upsertSpecs(partId, [makeSpec(name, value, 'manual', { sourceRef, verified: true, updatedBy: member, updatedAt: now })], member, now);
    });
  }

  /**
   * Add (delta > 0) or remove (delta < 0) stock in one drawer. Duplicate requestIds return the first result.
   * Removals that would make the drawer negative are rejected, which also resolves concurrent removals.
   */
  adjustStock(a: { requestId: string; partId: string; drawer: string; delta: number; member: string; reason: string; note?: string }) {
    return this.locked(async () => {
      if (!a.requestId) throw new HttpError(400, 'requestId required');
      if (!Number.isInteger(a.delta) || a.delta === 0) throw new HttpError(400, 'Quantity must be a non-zero whole number');
      const ledger = await this.store.read('ledger');
      const dup = ledger.find((l) => l.request_id === a.requestId);
      const current = (drawer: string) => ledger.filter((l) => l.part_id === a.partId && sameDrawer(l.drawer, drawer)).reduce((n, l) => n + Number(l.delta || 0), 0);
      if (dup) return { duplicate: true, entryId: dup.entry_id, balance: current(dup.drawer) };

      const parts = await this.store.read('parts');
      if (!parts.some((p) => p.part_id === a.partId)) throw new HttpError(404, 'Unknown part');
      const balance = current(a.drawer);
      if (a.delta < 0 && balance + a.delta < 0) throw new HttpError(409, `Only ${balance} ${drawerWords(a.drawer)}; cannot remove ${-a.delta}`, { balance });

      const locs = await this.store.read('locations');
      if (!locs.some((l) => l.part_id === a.partId && sameDrawer(l.drawer, a.drawer))) {
        if (a.delta < 0) throw new HttpError(404, `Part is not stored ${drawerWords(a.drawer)}`);
        await this.store.append('locations', [{ part_id: a.partId, drawer: normDrawer(a.drawer), added_by: a.member, added_at: new Date().toISOString(), request_id: a.requestId }]);
      }
      const entryId = `L-${randomUUID().slice(0, 8)}`;
      await this.store.append('ledger', [{
        entry_id: entryId, request_id: a.requestId, part_id: a.partId, drawer: normDrawer(a.drawer), delta: String(a.delta),
        member: a.member, timestamp: new Date().toISOString(), reason: a.reason, note: a.note ?? '',
      }]);
      return { duplicate: false, entryId, balance: balance + a.delta };
    });
  }

  async history(partId: string) {
    return (await this.store.read('ledger')).filter((l) => l.part_id === partId);
  }
}
