// HTTP API + static file server. Zero dependencies: node:http, and Node's built-in TypeScript stripping
// to serve the browser client (src/client, src/shared) as JavaScript.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { BarcodeHit, CatalogPart, OcrLine, Supplier } from '../shared/types.ts';
import { parseLabel } from '../shared/labels.ts';
import { detectCategory, makeSpec, summarize } from '../shared/specs.ts';
import { isCategory, UNASSIGNED_DRAWER, type ThreadSystem } from '../shared/hardware.ts';
import { search } from '../shared/query.ts';
import { identify, type CatalogProvider } from './catalog/index.ts';
import { HttpError, Inventory, partIdFor } from './inventory.ts';
import { login, verify, type Auth } from './auth.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg' };

export interface AppDeps { inventory: Inventory; providers: Record<Supplier, CatalogProvider>; auth: Auth }

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 2_000_000) throw new HttpError(413, 'Request too large'); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const str = (v: unknown, name: string, required = true): string => {
  if (v === undefined || v === null || v === '') { if (required) throw new HttpError(400, `${name} is required`); return ''; }
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be text`); // part numbers must never arrive as numbers
  return v;
};
const supplierOf = (v: unknown): Supplier => { if (v === 'mouser' || v === 'digikey') return v; throw new HttpError(400, 'supplier must be mouser or digikey'); };

function withSummary(p: { category: string; description: string; specs: CatalogPart['specs'] }) {
  // Saved parts already carry a category (hardware is chosen by the member); catalog records are detected.
  const category = isCategory(p.category) ? p.category : detectCategory(p.category, p.description);
  return { category, summary: summarize(category, p.specs) };
}

async function serveStatic(res: ServerResponse, urlPath: string) {
  // Sample bag photos are served only when explicitly enabled for local testing (they show PO/invoice numbers).
  const testPhotos = process.env.SERVE_TEST_PHOTOS === '1' && urlPath.startsWith('/test/photos/');
  let rel = urlPath === '/' ? '/public/index.html' : urlPath.startsWith('/src/client/') || urlPath.startsWith('/src/shared/') || testPhotos ? urlPath : `/public${urlPath}`;
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    let data: Buffer | string = await readFile(file);
    const ext = extname(file);
    if (ext === '.ts') data = stripTypeScriptTypes(data.toString('utf8'), { mode: 'strip' });
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

export function createApp(deps: AppDeps) {
  const { inventory, providers, auth } = deps;

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return serveStatic(res, path);

    if (path === '/api/status' && req.method === 'GET') {
      return send(res, 200, {
        mouser: providers.mouser.mode, digikey: providers.digikey.mode, store: inventory.store.mode, demoMembers: auth.demoMembers,
        // Public on purpose: the spreadsheet's own Google sharing settings control who can view or edit it.
        sheetUrl: inventory.store.viewUrl,
      });
    }
    if (path === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      const token = login(auth, str(b.name, 'name'), str(b.pin, 'pin'));
      if (!token) throw new HttpError(401, 'Unknown member or wrong PIN');
      return send(res, 200, { token, member: verify(auth, token) });
    }

    // Everything below is for signed-in team members only.
    const member = verify(auth, (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (!member) throw new HttpError(401, 'Sign in as a team member');

    if (path === '/api/parse' && req.method === 'POST') {
      const b = await body(req);
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      // Barcodes arrive as plain strings or as {text, x0, y0, x1, y1} with their position in the photo.
      const barcodes: BarcodeHit[] = (Array.isArray(b.barcodes) ? b.barcodes : []).slice(0, 100).flatMap((x: any) =>
        typeof x === 'string' ? [{ text: x }] : x && typeof x.text === 'string' ? [{ text: x.text, format: typeof x.format === 'string' ? x.format : undefined, x0: num(x.x0), y0: num(x.y0), x1: num(x.x1), y1: num(x.y1) }] : []);
      const lines: OcrLine[] = (Array.isArray(b.lines) ? b.lines : []).slice(0, 500).flatMap((l: any) =>
        l && typeof l.text === 'string' && [l.x0, l.y0, l.x1, l.y1].every((v) => num(v) !== undefined) ? [{ text: l.text, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }] : []);
      const altTexts = (Array.isArray(b.altTexts) ? b.altTexts : []).slice(0, 8).filter((t: unknown): t is string => typeof t === 'string').map((t: string) => t.slice(0, 20000));
      const override = b.supplier === 'mcmaster' ? 'mcmaster' : b.supplier ? supplierOf(b.supplier) : undefined;
      return send(res, 200, parseLabel(str(b.text, 'text', false), barcodes, override, lines, altTexts));
    }

    if (path === '/api/identify' && req.method === 'POST') {
      const b = await body(req);
      const input = { supplier: supplierOf(b.supplier), sku: str(b.sku, 'sku', false) || undefined, mpn: str(b.mpn, 'mpn', false) || undefined, manufacturer: str(b.manufacturer, 'manufacturer', false) || undefined };
      if (!input.sku && !input.mpn) throw new HttpError(400, 'Enter a supplier SKU or manufacturer part number');
      const result = await identify(input, providers);
      // Match the reviewed candidate's exact identity, including MPN-only and other-supplier scans.
      // A SKU from an incorrect label must never route stock to a different component.
      const stored = await inventory.loadAll();
      const existingFor = (part: CatalogPart) => {
        const p = stored.find((p) => p.partId === partIdFor(part.manufacturer, part.mpn));
        return p ? { partId: p.partId, locations: p.locations } : undefined;
      };
      const present = (part: CatalogPart) => ({ ...part, ...withSummary(part), existing: existingFor(part) });
      return send(res, 200, {
        ...result,
        chosen: result.chosen ? present(result.chosen) : undefined,
        candidates: result.candidates.map((c) => ({ ...c, part: present(c.part) })),
        existing: result.status === 'matched' && result.chosen ? existingFor(result.chosen) : undefined,
        catalogMode: { primary: providers[input.supplier].mode, other: providers[input.supplier === 'mouser' ? 'digikey' : 'mouser'].mode },
      });
    }

    if (path === '/api/parts' && req.method === 'POST') {
      const b = await body(req);
      const p = b.part ?? {};
      const part: CatalogPart = {
        supplier: supplierOf(p.supplier), sku: str(p.sku, 'part.sku', false), altSkus: [],
        manufacturer: str(p.manufacturer, 'part.manufacturer'), mpn: str(p.mpn, 'part.mpn'),
        description: str(p.description, 'part.description', false), category: str(p.category, 'part.category', false),
        productUrl: str(p.productUrl, 'productUrl', false) || undefined, datasheetUrl: str(p.datasheetUrl, 'datasheetUrl', false) || undefined,
        // Re-derive parsed fields server-side; only the original name/value/source/link are trusted from the client.
        specs: Array.isArray(p.specs) ? p.specs
          .filter((s: any) => typeof s?.name === 'string' && typeof s?.value === 'string' && ['mouser', 'digikey', 'label'].includes(s.source))
          .map((s: any) => makeSpec(s.name, s.value, s.source, { sourceRef: typeof s.sourceRef === 'string' ? s.sourceRef : undefined })) : [],
        origin: p.origin === 'live' ? 'live' : 'demo',
      };
      const labelSku = part.sku ? { supplier: part.supplier, sku: part.sku } : undefined;
      const cross = b.crossSku && typeof b.crossSku.sku === 'string' ? { supplier: supplierOf(b.crossSku.supplier), sku: b.crossSku.sku } : undefined;
      const r = await inventory.save({
        requestId: str(b.requestId, 'requestId'), member, drawer: str(b.drawer, 'drawer', false), part, labelSku, crossSku: cross,
        manualSpecs: Array.isArray(b.manualSpecs) ? b.manualSpecs.map((m: any) => ({ name: str(m.name, 'spec name'), value: str(m.value, 'spec value'), sourceRef: str(m.sourceRef, 'datasheet page or source link') })) : [],
      });
      const saved = await inventory.getPart(r.partId);
      return send(res, 200, { ...r, part: saved && { ...saved, ...withSummary(saved) } });
    }

    if (path === '/api/search' && req.method === 'GET') {
      const all = await inventory.loadAll();
      const hits = search(all, url.searchParams.get('q') ?? '').slice(0, 50);
      return send(res, 200, { total: all.length, hits: hits.map((h) => ({ ...h, part: { ...h.part, ...withSummary(h.part) } })) });
    }

    if (path === '/api/drawers' && req.method === 'GET') {
      const locs = await inventory.store.read('locations');
      return send(res, 200, [...new Set(locs.map((l) => l.drawer))].filter((d) => d && d !== UNASSIGNED_DRAWER).sort());
    }

    if (path === '/api/hardware' && req.method === 'POST') {
      const b = await body(req);
      const supplier = b.supplier ? (b.supplier === 'mcmaster' ? 'mcmaster' : supplierOf(b.supplier)) : undefined;
      const sys = b.threadSystem === 'metric' || b.threadSystem === 'imperial' ? (b.threadSystem as ThreadSystem) : undefined;
      if (b.category !== undefined && typeof b.category !== 'string') throw new HttpError(400, 'category must be text');
      const r = await inventory.saveHardware({
        requestId: str(b.requestId, 'requestId'), member, name: str(b.name, 'Part name'), category: b.category,
        supplier, sku: str(b.sku, 'sku', false), productUrl: str(b.productUrl, 'productUrl', false), description: str(b.description, 'description', false),
        threadSystem: sys, drawer: str(b.drawer, 'drawer', false), partId: str(b.partId, 'partId', false) || undefined,
        specSource: str(b.specSource, 'specSource', false),
        specs: Array.isArray(b.specs) ? b.specs.slice(0, 40).map((s: any) => ({ name: str(s?.name, 'spec name', false), value: str(s?.value, 'spec value', false) })) : [],
      });
      const saved = await inventory.getPart(r.partId);
      return send(res, 200, { ...r, part: saved && { ...saved, ...withSummary(saved) } });
    }

    const m = /^\/api\/parts\/(P-[0-9a-f]+|HW-[0-9A-F]+)(\/specs|\/refresh|\/history|\/locations)?$/.exec(path);
    if (m) {
      const id = m[1];
      if (!m[2] && req.method === 'DELETE') return send(res, 200, await inventory.deletePart(id));
      if (!m[2] && req.method === 'GET') {
        const p = await inventory.getPart(id);
        if (!p) throw new HttpError(404, 'Unknown part');
        return send(res, 200, { ...p, ...withSummary(p), history: await inventory.history(id) });
      }
      if (m[2] === '/specs' && req.method === 'POST') {
        const b = await body(req);
        await inventory.editSpec(id, str(b.name, 'name'), str(b.value, 'value'), str(b.sourceRef, 'sourceRef'), member);
        return send(res, 200, { ok: true });
      }
      if (m[2] === '/locations' && req.method === 'POST') {
        const b = await body(req);
        return send(res, 200, await inventory.addLocation(id, str(b.drawer, 'drawer', false), member, str(b.requestId, 'requestId')));
      }
      if (m[2] === '/refresh' && req.method === 'POST') {
        const p = await inventory.getPart(id);
        if (!p) throw new HttpError(404, 'Unknown part');
        for (const s of p.skus) {
          if (s.supplier !== 'mouser' && s.supplier !== 'digikey') continue; // no McMaster catalog lookup yet
          const found = (await providers[s.supplier].lookup(s.sku)).filter((c) => c.mpn.toUpperCase() === p.mpn.toUpperCase());
          if (found.length === 1) await inventory.refreshSpecs(id, found[0], member);
        }
        const after = await inventory.getPart(id);
        return send(res, 200, after && { ...after, ...withSummary(after) });
      }
    }

    if (path === '/api/stock' && req.method === 'POST') {
      const b = await body(req);
      const delta = Number(b.delta);
      const r = await inventory.adjustStock({
        requestId: str(b.requestId, 'requestId'), partId: str(b.partId, 'partId'), drawer: str(b.drawer, 'drawer', false),
        delta, member, reason: str(b.reason, 'reason', false) || (delta > 0 ? 'receive' : 'remove'), note: str(b.note, 'note', false),
      });
      return send(res, 200, r);
    }

    throw new HttpError(404, 'No such endpoint');
  }

  return createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: (e as Error).message, details: e instanceof HttpError ? e.details : undefined });
    });
  });
}
