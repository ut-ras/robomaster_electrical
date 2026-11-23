// Browser client. Served by the Node server with types stripped, so it must use only erasable TypeScript.

import type { BarcodeHit, CatalogPart, FieldValue, InventoryPart, LabelFields, OcrLine, Spec, Supplier } from '../shared/types.ts';
import { readBarcodes } from './barcodes.ts';

type Summary = { label: string; value: string; known: boolean; sources: string[] }[];
type WithSummary<T> = T & { category: string; summary: Summary };

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

// ---------- tiny DOM helper ----------
type Attrs = Record<string, string | boolean | number | ((e: any) => void) | undefined>;
function h(tag: string, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) el.value = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
const $view = () => document.getElementById('view')!;
function show(...nodes: (Node | null | false)[]) { const v = $view(); v.replaceChildren(...(nodes.filter(Boolean) as Node[])); window.scrollTo(0, 0); }
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// ---------- API ----------
let token = safeGet('token');
let member = safeGet('member');
function safeGet(k: string) { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } }
function safeSet(k: string, v: string) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } }

async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { signOut(); throw new Error('Please sign in again'); }
  if (!res.ok) { const err = new Error(json.error ?? `HTTP ${res.status}`) as Error & { status?: number; details?: unknown }; err.status = res.status; err.details = json.details; throw err; }
  return json as T;
}

// ---------- sign in ----------
function signOut() { token = ''; member = ''; safeSet('token', ''); safeSet('member', ''); renderLogin(); }

async function renderLogin() {
  document.getElementById('tabs')!.hidden = true;
  document.getElementById('signout')!.hidden = true;
  const status = await api('/api/status').catch(() => null);
  const name = h('input', { autocomplete: 'username', placeholder: 'Your name' }) as HTMLInputElement;
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', placeholder: 'Team PIN' }) as HTMLInputElement;
  const msg = h('div');
  show(h('div', { class: 'card' },
    h('h2', {}, 'Team sign-in'),
    h('p', { class: 'muted' }, 'Only team members can save parts or change stock.'),
    status?.demoMembers ? h('div', { class: 'notice warn' }, 'Demo server: sign in as "Demo One" / 1111 or "Demo Two" / 2222.') : null,
    h('label', {}, 'Name'), name, h('label', {}, 'PIN'), pin, msg,
    h('button', { class: 'primary big', onclick: async () => {
      try {
        const r = await api<{ token: string; member: string }>('/api/login', { body: { name: name.value, pin: pin.value } });
        token = r.token; member = r.member; safeSet('token', token); safeSet('member', member);
        start();
      } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
    } }, 'Sign in')));
}

async function showModes() {
  const s = await api('/api/status').catch(() => null);
  if (!s) return;
  const tag = (label: string, mode: string) => `${label}: ${mode === 'live' || mode === 'sheets' ? 'live' : 'demo'}`;
  document.getElementById('modes')!.textContent = `${member} · ${tag('Mouser', s.mouser)} · ${tag('DigiKey', s.digikey)} · ${s.store === 'sheets' ? 'Google Sheet' : 'local demo sheet'}`;
}

// ---------- scan ----------
interface ScanState {
  photoUrl?: string;
  ocrText: string;
  barcodes: BarcodeHit[];
  fields: LabelFields;
  requestId: string;
}

let cameraInput: HTMLInputElement | undefined;

function renderScan() {
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: (e: Event) => onPhoto(e) }) as HTMLInputElement;
  const upload = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e: Event) => onPhoto(e) }) as HTMLInputElement;
  cameraInput = camera;
  show(h('div', { class: 'card' },
    h('h2', {}, 'Scan a package'),
    h('p', { class: 'muted' }, 'Photograph the Mouser or DigiKey label flat and in focus. Nothing is saved and stock is not changed until you confirm.'),
    camera, upload,
    h('button', { class: 'primary big', onclick: () => camera.click() }, 'Take photo'),
    h('button', { class: 'big', onclick: () => upload.click() }, 'Upload photo'),
    h('button', { class: 'big', onclick: () => renderReview({ ocrText: '', barcodes: [], fields: {}, requestId: uuid() }) }, 'Enter part number'),
  ));
}

/** Opens the camera again (used by "Retake close-up"); stays in the scan flow. */
function retake() {
  renderScan();
  cameraInput?.click();
}

async function onPhoto(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const photoUrl = URL.createObjectURL(file);
  const bar = h('div');
  const status = h('div', { class: 'muted' }, 'Reading label text and barcodes…');
  const progress = h('div', { class: 'progress' }, bar);
  show(photoBlock(photoUrl), h('div', { class: 'card' }, status, progress));
  const img = await loadImage(photoUrl);
  const { canvas, scale } = prepare(img);
  let ocrP = 0, bcP = 0;
  const tick = () => { bar.style.width = `${Math.round(((ocrP + bcP) / 2) * 100)}%`; };
  const [barcodes, ocrRes] = await Promise.all([
    readBarcodes(img, (p) => { bcP = p; tick(); }).catch((err) => { console.warn('barcodes', err); return [] as BarcodeHit[]; }),
    ocr(canvas, (p) => { ocrP = p; tick(); }).catch((err) => { status.textContent = `OCR failed: ${(err as Error).message}`; return { text: '', lines: [] as OcrLine[] }; }),
  ]);
  // OCR ran on a downscaled copy; put its line boxes back into original-photo pixels like the barcodes.
  const lines = ocrRes.lines.map((l) => ({ text: l.text, x0: l.x0 / scale, y0: l.y0 / scale, x1: l.x1 / scale, y1: l.y1 / scale }));
  const fields = await api<LabelFields>('/api/parse', { body: { text: ocrRes.text, barcodes, lines } });
  renderReview({ photoUrl, ocrText: ocrRes.text, barcodes, fields, requestId: uuid() });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
}

/**
 * Resize to a size Tesseract reads well (downscale big phone photos to ~2000 px, upscale small screenshots
 * to ~1600 px) and convert to high-contrast grayscale, which helps on glossy bags.
 */
function prepare(img: HTMLImageElement): { canvas: HTMLCanvasElement; scale: number } {
  const side = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = side < 1000 ? 1600 / side : Math.min(1, 2000 / side);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const y = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
    const v = Math.max(0, Math.min(255, (y - 128) * 1.5 + 128));
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
  }
  ctx.putImageData(d, 0, 0);
  return { canvas: c, scale };
}

let tesseractLoad: Promise<any> | undefined;
async function ocr(canvas: HTMLCanvasElement, onProgress: (p: number) => void): Promise<{ text: string; lines: OcrLine[] }> {
  tesseractLoad ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL; s.onload = () => ok((window as any).Tesseract); s.onerror = () => fail(new Error('could not load OCR engine (offline?)'));
    document.head.append(s);
  });
  const T = await tesseractLoad;
  const worker = await T.createWorker('eng', 1, { logger: (m: any) => { if (m.status === 'recognizing text') onProgress(m.progress); } });
  try {
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const lines: OcrLine[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) {
      lines.push({ text: String(l.text).trim(), x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 });
    }
    return { text: data.text as string, lines };
  } finally { await worker.terminate(); }
}

function photoBlock(url?: string) {
  if (!url) return null;
  const wrap = h('div', { class: 'photo' }, h('div', { class: 'frame' }, h('img', { src: url, alt: 'Label photo' })),
    h('div', { class: 'muted' }, 'Tap the photo to zoom while you check each character.'));
  wrap.addEventListener('click', () => wrap.classList.toggle('zoom'));
  return wrap;
}

// ---------- review ----------
function sourceNote(f: FieldValue | undefined) {
  if (!f) return null;
  const text = f.source === 'barcode' ? ` ✓ ${f.verifiedBy ?? 'barcode'}` : f.source === 'ocr' ? ` from text${f.verifiedBy ? ` (${f.verifiedBy})` : ''} – check against photo` : ` ${f.source}`;
  return h('span', { class: f.source === 'barcode' ? 'src ok-text' : 'src' }, text);
}

function fieldInput(label: string, f: FieldValue | undefined, opts: { pn?: boolean; numeric?: boolean; guess?: string } = {}) {
  const input = h('input', { 'aria-label': label, value: f?.value ?? '', class: opts.pn ? 'pn' : undefined, inputmode: opts.numeric ? 'numeric' : undefined, autocapitalize: opts.pn ? 'characters' : undefined, autocorrect: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const hint = opts.guess ? h('div', { class: 'src' }, 'Text read as ', h('span', { class: 'mono' }, `"${opts.guess}"`), ' – not trusted. ',
    h('button', { class: 'link', onclick: () => { input.value = opts.guess!; input.focus(); } }, 'Use it anyway')) : null;
  return { node: h('div', {}, h('label', {}, label, sourceNote(f)), input, hint), input };
}

async function renderReview(st: ScanState) {
  const f = st.fields;
  const supplier = h('select', { 'aria-label': 'Supplier' }, h('option', { value: '' }, 'Choose supplier…'), h('option', { value: 'mouser' }, 'Mouser'), h('option', { value: 'digikey' }, 'DigiKey')) as HTMLSelectElement;
  supplier.value = f.supplier?.value ?? '';
  const sku = fieldInput('Supplier part number (SKU)', f.sku, { pn: true, guess: f.guesses?.sku });
  const mpn = fieldInput('Manufacturer part number', f.mpn, { pn: true, guess: f.guesses?.mpn });
  const mfr = fieldInput('Manufacturer', f.manufacturer);
  const desc = fieldInput('Description', f.description);
  const qty = fieldInput('Printed quantity', f.quantity, { numeric: true });
  const out = h('div');

  const lookup = async () => {
    if (!supplier.value) { out.replaceChildren(h('div', { class: 'notice warn' }, 'Choose the supplier first.')); return; }
    if (!sku.input.value.trim() && !mpn.input.value.trim()) { out.replaceChildren(h('div', { class: 'notice warn' }, 'Enter the SKU or manufacturer part number first.')); return; }
    out.replaceChildren(h('p', { class: 'muted' }, 'Looking up catalog…'));
    try {
      const r = await api('/api/identify', { body: { supplier: supplier.value, sku: sku.input.value.trim(), mpn: mpn.input.value.trim(), manufacturer: mfr.input.value.trim() } });
      out.replaceChildren(renderIdentify(r, st, { supplier: supplier.value as Supplier, sku: sku.input.value.trim(), mpn: mpn.input.value.trim(), manufacturer: mfr.input.value.trim(), description: desc.input.value.trim(), printedQty: qty.input.value.trim() }));
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { out.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
  };

  // Photo scans where neither identifier could be trusted get a clear stop instead of junk in the fields.
  const unreadable = st.photoUrl && f.partNumberStatus === 'unreadable'
    ? h('div', { class: 'notice bad', role: 'alert' },
        h('strong', {}, 'Couldn’t read the part number'),
        h('div', {}, 'Neither the supplier SKU nor the manufacturer part number could be read reliably from this photo.'),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'primary', onclick: retake }, 'Retake close-up'),
          h('button', { onclick: () => { sku.input.focus(); sku.input.scrollIntoView({ block: 'center' }); } }, 'Enter SKU manually')),
        h('div', { class: 'src', style: 'margin-top:6px' }, 'Tip: fill the frame with the label, hold the phone flat, avoid glare on the barcodes.'))
    : null;

  // Barcodes we decoded but could not tie to a field: one tap assigns them.
  const unassigned = (f.unassigned ?? []).length
    ? h('div', {}, h('label', {}, 'Other barcodes on the label (tap to use)'),
        ...(f.unassigned ?? []).map((t) => h('div', { class: 'row', style: 'margin:4px 0' }, h('span', { class: 'mono' }, t),
          h('button', { onclick: () => { sku.input.value = t; } }, 'SKU'), h('button', { onclick: () => { mpn.input.value = t; } }, 'MPN'),
          /^\d+$/.test(t) ? h('button', { onclick: () => { qty.input.value = t; } }, 'Qty') : null)))
    : null;

  show(
    photoBlock(st.photoUrl),
    h('div', { class: 'card' },
      h('h2', {}, st.photoUrl ? 'Check what was read' : 'Enter part number'),
      unreadable,
      h('label', {}, 'Supplier', f.supplier ? h('span', { class: 'src' }, ` (${f.supplier.reason})`) : null), supplier,
      sku.node, mpn.node, mfr.node, desc.node, qty.node, unassigned,
      st.photoUrl ? h('details', {}, h('summary', {}, 'Raw OCR text and barcodes'),
        h('pre', { class: 'mono muted', style: 'white-space:pre-wrap' }, st.ocrText || '(no text)'),
        h('p', { class: 'muted' }, st.barcodes.length ? `Barcodes decoded: ${st.barcodes.map((b) => b.text).join(' | ')}` : 'No barcodes decoded.')) : null,
      h('button', { class: 'primary big', onclick: lookup }, 'Look up in catalog'),
      h('button', { class: 'big', onclick: renderScan }, 'Start over'),
    ),
    out,
  );
}

interface LabelInfo { supplier: Supplier; sku: string; mpn: string; manufacturer: string; description: string; printedQty: string }

function summaryList(summary: Summary) {
  return h('dl', { class: 'summary' }, ...summary.flatMap((s) => [h('dt', {}, s.label), h('dd', { class: s.known ? '' : 'unknown' }, s.value, s.known && s.sources.length ? h('span', { class: 'src' }, ` · ${s.sources.join(', ')}`) : null)]));
}

function specTable(specs: Spec[]) {
  return h('details', {}, h('summary', {}, `All specs (${specs.length})`),
    h('table', { class: 'specs' }, ...specs.map((s) => h('tr', {},
      h('td', {}, s.name), h('td', {}, s.value, s.condition && !s.value.includes(s.condition) ? h('div', { class: 'src' }, s.condition) : null),
      h('td', { class: 'src' }, s.verified ? 'verified · ' : '', s.source, s.sourceRef ? h('div', {}, /^https?:\/\//i.test(s.sourceRef) ? h('a', { href: s.sourceRef, target: '_blank', rel: 'noopener' }, 'source') : s.sourceRef) : null)))));
}

function links(p: { productUrl?: string; datasheetUrl?: string }) {
  return h('p', {},
    p.productUrl ? h('a', { href: p.productUrl, target: '_blank', rel: 'noopener' }, 'Product page') : null,
    p.productUrl ? ' · ' : '',
    p.datasheetUrl ? h('a', { href: p.datasheetUrl, target: '_blank', rel: 'noopener' }, 'Datasheet') : h('span', { class: 'unknown' }, 'No datasheet link'));
}

function renderIdentify(r: any, st: ScanState, label: LabelInfo): HTMLElement {
  const box = h('div');
  const statusBadge = r.status === 'matched' ? h('span', { class: 'badge ok' }, 'Exact match') : r.status === 'review' ? h('span', { class: 'badge warn' }, 'Needs review') : h('span', { class: 'badge bad' }, 'Not found');
  const head = h('div', { class: 'card' }, h('h2', {}, 'Catalog result ', statusBadge),
    h('p', { class: 'muted' }, `Catalog data: ${r.catalogMode.primary === 'live' ? 'live API' : 'DEMO data'} (${label.supplier})`),
    ...r.reasons.map((x: string) => h('div', { class: 'notice warn' }, x)),
    r.existing ? h('div', { class: 'notice ok' }, 'Already in inventory: ', ...r.existing.locations.map((l: any) => h('span', { class: 'badge drawer' }, l.drawer))) : null);
  box.append(head);

  if (r.status === 'not_found') {
    box.append(manualPartForm(st, label));
    return box;
  }
  const detail = h('div');
  const pick = (part: WithSummary<CatalogPart>) => detail.replaceChildren(partReview(part, r.crossSku, r.gapFill, st, label));
  if (r.status === 'review' && r.candidates.length) {
    head.append(h('h3', {}, 'Choose the exact part'), ...r.candidates.map((c: any, i: number) => {
      const radio = h('input', { type: 'radio', name: 'cand', onchange: () => pick(c.part) }) as HTMLInputElement;
      if (r.chosen && c.part.sku === r.chosen.sku && c.part.mpn === r.chosen.mpn) radio.checked = true;
      return h('label', { class: 'cand' }, radio, h('div', {},
        h('div', { class: 'mono' }, c.part.mpn), h('div', { class: 'muted' }, `${c.part.manufacturer} · ${c.part.sku}`),
        h('div', {}, c.mpnMatch === false ? h('span', { class: 'badge bad' }, 'MPN differs') : c.mpnMatch ? h('span', { class: 'badge ok' }, 'MPN matches') : null,
          c.manufacturerMatch === false ? h('span', { class: 'badge bad' }, 'Manufacturer differs') : c.manufacturerMatch ? h('span', { class: 'badge ok' }, 'Manufacturer matches') : null),
        h('div', { class: 'muted' }, c.part.description)));
    }), h('button', { class: 'link', onclick: () => detail.replaceChildren(manualPartForm(st, label)) }, 'None of these – enter manually'));
  }
  if (r.chosen) pick(r.chosen);
  box.append(detail);
  return box;
}

function manualSpecsEditor() {
  const rows = h('div');
  const add = () => {
    const name = h('input', { placeholder: 'Spec name, e.g. Tolerance' });
    const value = h('input', { placeholder: 'Value as printed, e.g. -20%, +80%' });
    const ref = h('input', { placeholder: 'Datasheet page or link (required)' });
    rows.append(h('div', { class: 'card', 'data-spec': '1' }, name, value, ref));
  };
  const node = h('div', {}, h('h3', {}, 'Add or correct specs'), h('p', { class: 'muted' }, 'Manual values are marked verified and survive catalog refreshes.'), rows, h('button', { onclick: add }, '+ Add spec'));
  const read = () => [...rows.querySelectorAll('[data-spec]')].map((d) => {
    const [n, v, s] = [...d.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value.trim());
    return { name: n, value: v, sourceRef: s };
  }).filter((x) => x.name || x.value);
  return { node, read };
}

function drawerPicker() {
  const id = `dl-${Math.random().toString(36).slice(2)}`;
  const input = h('input', { 'aria-label': 'Drawer', list: id, placeholder: 'e.g. A3', autocapitalize: 'characters' }) as HTMLInputElement;
  const dl = h('datalist', { id });
  api<string[]>('/api/drawers').then((ds) => dl.replaceChildren(...ds.map((d) => h('option', { value: d })))).catch(() => {});
  return { node: h('div', {}, h('label', {}, 'Drawer'), input, dl), input };
}

function partReview(part: WithSummary<CatalogPart>, crossSku: any, gapFill: any, st: ScanState, label: LabelInfo) {
  const drawer = drawerPicker();
  const manual = manualSpecsEditor();
  const msg = h('div');
  const saveBtn = h('button', { class: 'primary big' }, 'Save to inventory') as HTMLButtonElement;
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    msg.replaceChildren(h('p', { class: 'muted' }, 'Saving…'));
    try {
      const r = await api('/api/parts', { body: { requestId: st.requestId, drawer: drawer.input.value, part: { ...part, sku: label.sku || part.sku }, crossSku, manualSpecs: manual.read() } });
      msg.replaceChildren(h('div', { class: 'notice ok' }, `${r.created ? 'Saved new part' : 'Updated existing part'} in drawer ${drawer.input.value}.`), receiveStock(r.partId, drawer.input.value, label.printedQty));
      saveBtn.textContent = 'Saved';
    } catch (e) {
      saveBtn.disabled = false; // same requestId on retry, so a double save is harmless
      msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message));
    }
  };
  return h('div', { class: 'card' },
    h('h2', { class: 'mono' }, part.mpn),
    h('div', {}, part.manufacturer, ' · ', h('span', { class: 'badge' }, part.category), part.origin === 'demo' ? h('span', { class: 'badge warn' }, 'demo data') : h('span', { class: 'badge ok' }, 'live')),
    h('p', { class: 'muted' }, part.description),
    h('p', { class: 'muted' }, `${part.supplier}: `, h('span', { class: 'mono' }, part.sku), crossSku ? ` · also ${crossSku.supplier}: ` : '', crossSku ? h('span', { class: 'mono' }, crossSku.sku) : ''),
    gapFill ? h('p', { class: 'muted' }, gapFill.addedKeys?.length ? `Filled ${gapFill.addedKeys.length} specs from ${gapFill.supplier} (exact manufacturer + MPN match).` : `${gapFill.supplier} not used: ${gapFill.rejected ?? 'nothing to add'}.`) : null,
    summaryList(part.summary), specTable(part.specs), links(part),
    manual.node, drawer.node, saveBtn, msg);
}

function manualPartForm(st: ScanState, label: LabelInfo) {
  const mfr = h('input', { value: label.manufacturer }) as HTMLInputElement;
  const mpn = h('input', { value: label.mpn, class: 'pn' }) as HTMLInputElement;
  const desc = h('input', { value: label.description }) as HTMLInputElement;
  const cat = h('select', {}, ...['capacitor', 'resistor', 'inductor', 'ic', 'connector', 'other'].map((c) => h('option', { value: c }, c))) as HTMLSelectElement;
  const ds = h('input', { placeholder: 'https://…' }) as HTMLInputElement;
  const drawer = drawerPicker();
  const manual = manualSpecsEditor();
  const msg = h('div');
  return h('div', { class: 'card' },
    h('h2', {}, 'Enter part manually'),
    h('label', {}, 'Manufacturer'), mfr, h('label', {}, 'Manufacturer part number'), mpn, h('label', {}, 'Description'), desc,
    h('label', {}, 'Category'), cat, h('label', {}, 'Datasheet link'), ds,
    manual.node, drawer.node,
    h('button', { class: 'primary big', onclick: async () => {
      try {
        const specs = manual.read();
        if (specs.some((s) => !s.sourceRef)) throw new Error('Every manual spec needs a datasheet page or source link');
        const r = await api('/api/parts', { body: { requestId: st.requestId, drawer: drawer.input.value, manualSpecs: specs,
          part: { supplier: label.supplier, sku: label.sku, manufacturer: mfr.value, mpn: mpn.value, description: desc.value, category: cat.value, datasheetUrl: ds.value, specs: [], origin: 'demo' } } });
        msg.replaceChildren(h('div', { class: 'notice ok' }, 'Saved.'), receiveStock(r.partId, drawer.input.value, label.printedQty));
      } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
    } }, 'Save to inventory'), msg);
}

/** Optional step after saving. Suggests the printed quantity but requires the member to type the real count. */
function receiveStock(partId: string, drawer: string, printed: string) {
  const requestId = uuid();
  const count = h('input', { inputmode: 'numeric', placeholder: printed ? `Printed: ${printed}` : 'Count' }) as HTMLInputElement;
  const msg = h('div');
  return h('div', { class: 'card' },
    h('h3', {}, 'Add stock to ', h('span', { class: 'badge drawer' }, drawer), ' (optional)'),
    h('p', { class: 'muted' }, printed ? `The label says ${printed}. Old bags may be open – count what is actually inside.` : 'Count what is in the bag.'),
    h('div', { class: 'row' }, count, printed ? h('button', { onclick: () => { count.value = printed; count.focus(); } }, `Use ${printed}`) : null),
    h('button', { class: 'primary big', onclick: async () => {
      const n = Number(count.value);
      if (!Number.isInteger(n) || n <= 0) { msg.replaceChildren(h('div', { class: 'notice warn' }, 'Type the counted quantity.')); return; }
      try {
        const r = await api('/api/stock', { body: { requestId, partId, drawer, delta: n, reason: 'receive', note: printed ? `printed qty ${printed}` : '' } });
        msg.replaceChildren(h('div', { class: 'notice ok' }, r.duplicate ? `Already recorded. ${drawer} has ${r.balance}.` : `Recorded. ${drawer} now has ${r.balance}.`));
      } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
    } }, 'Confirm count'), msg);
}

// ---------- search ----------
let lastQuery = '';
function renderSearch() {
  const q = h('input', { type: 'search', placeholder: 'SKU, MPN, "100 nF cap ≥25 V ±10%", drawer…', value: lastQuery, autocapitalize: 'off', autocorrect: 'off' }) as HTMLInputElement;
  const results = h('div');
  let t: number | undefined;
  const run = async () => {
    lastQuery = q.value;
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q.value)}`);
      results.replaceChildren(h('p', { class: 'muted' }, `${r.hits.length} of ${r.total} parts`), ...r.hits.map((hit: any) => resultCard(hit)));
    } catch (e) { results.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
  };
  q.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(run, 250); });
  show(h('div', { class: 'card' }, h('h2', {}, 'Search inventory'), q,
    h('p', { class: 'muted' }, 'Try a supplier SKU, a manufacturer part number, "100 nF capacitor, at least 25 V, ±10% or tighter", or a drawer like "drawer A3".')), results);
  run();
}

function drawerBadges(p: InventoryPart) {
  if (!p.locations.length) return h('span', { class: 'unknown' }, 'no drawer');
  return h('span', {}, ...p.locations.map((l) => h('span', { class: 'badge drawer' }, l.drawer, l.qty !== null ? ` × ${l.qty}` : '')));
}

function resultCard(hit: { part: WithSummary<InventoryPart>; checks: { ok: boolean; why: string }[] }) {
  const p = hit.part;
  return h('button', { class: 'result', onclick: () => renderPart(p.partId) },
    h('div', {}, drawerBadges(p)),
    h('div', { class: 'mono' }, p.mpn), h('div', { class: 'muted' }, `${p.manufacturer} · ${p.skus.map((s) => s.sku).join(' · ')}`),
    h('div', {}, ...p.summary.filter((s) => s.known).slice(0, 4).map((s) => h('span', { class: 'badge' }, `${s.label}: ${s.value}`))),
    hit.checks.length ? h('div', { class: 'src' }, hit.checks.map((c) => c.why).join(' · ')) : null);
}

async function renderPart(partId: string) {
  const p = await api(`/api/parts/${partId}`);
  const msg = h('div');
  const stockRow = (loc: { drawer: string; qty: number | null }) => {
    const n = h('input', { inputmode: 'numeric', placeholder: 'qty', style: 'max-width:90px' }) as HTMLInputElement;
    let rid = uuid(); // one id per intended change; reused if the same tap is retried
    const act = async (sign: 1 | -1) => {
      const q = Number(n.value);
      if (!Number.isInteger(q) || q <= 0) { msg.replaceChildren(h('div', { class: 'notice warn' }, 'Enter a whole number.')); return; }
      try {
        const r = await api('/api/stock', { body: { requestId: rid, partId, drawer: loc.drawer, delta: sign * q, reason: sign > 0 ? 'receive' : 'remove' } });
        rid = uuid();
        msg.replaceChildren(h('div', { class: 'notice ok' }, `${loc.drawer} now has ${r.balance}.`));
        renderPart(partId);
      } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
    };
    return h('div', { class: 'row', style: 'margin:6px 0' }, h('span', {}, h('span', { class: 'badge drawer' }, loc.drawer), ` ${loc.qty === null ? 'not counted' : loc.qty}`), n,
      h('button', { onclick: () => act(-1) }, '− Take'), h('button', { onclick: () => act(1) }, '+ Add'));
  };
  const newDrawer = drawerPicker();
  const edit = manualSpecsEditor();
  show(
    h('button', { class: 'link', onclick: renderSearch }, '‹ Back to search'),
    h('div', { class: 'card' },
      h('h2', { class: 'mono' }, p.mpn), h('div', {}, p.manufacturer, ' · ', h('span', { class: 'badge' }, p.category)),
      h('p', { class: 'muted' }, p.description),
      h('p', {}, ...p.skus.map((s: any) => h('span', { class: 'badge' }, `${s.supplier}: `, h('span', { class: 'mono' }, s.sku), s.onLabel ? '' : ' (catalog)'))),
      summaryList(p.summary), specTable(p.specs), links(p),
      h('button', { onclick: async () => { try { await api(`/api/parts/${partId}/refresh`, { body: {} }); renderPart(partId); } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); } } }, 'Refresh catalog specs')),
    h('div', { class: 'card' }, h('h3', {}, 'Locations and stock'), ...p.locations.map(stockRow), msg,
      newDrawer.node, h('button', { onclick: async () => {
        try {
          await api('/api/parts', { body: { requestId: uuid(), drawer: newDrawer.input.value, part: { supplier: p.skus[0]?.supplier ?? 'mouser', sku: '', manufacturer: p.manufacturer, mpn: p.mpn, description: p.description, category: p.category, specs: [] } } });
          renderPart(partId);
        } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
      } }, 'Add drawer')),
    h('div', { class: 'card' }, edit.node, h('button', { class: 'primary', onclick: async () => {
      try {
        for (const s of edit.read()) await api(`/api/parts/${partId}/specs`, { body: s });
        renderPart(partId);
      } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
    } }, 'Save specs')),
    h('div', { class: 'card' }, h('h3', {}, 'Stock history'), p.history.length ? h('table', { class: 'specs' }, ...p.history.map((l: any) =>
      h('tr', {}, h('td', {}, new Date(l.timestamp).toLocaleString()), h('td', {}, l.member), h('td', {}, l.drawer), h('td', {}, Number(l.delta) > 0 ? `+${l.delta}` : l.delta)))) : h('p', { class: 'muted' }, 'No stock changes recorded.')),
  );
}

// ---------- shell ----------
function start() {
  document.getElementById('tabs')!.hidden = false;
  const so = document.getElementById('signout')!;
  so.hidden = false; so.onclick = signOut;
  showModes();
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
      if (b.dataset.tab === 'search') renderSearch(); else renderScan();
    };
  });
  renderScan();
}

if (token) start(); else renderLogin();
