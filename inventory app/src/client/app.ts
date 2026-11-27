// Browser client. Served by the Node server with types stripped, so it must use only erasable TypeScript.

import type { BarcodeHit, CatalogPart, CatalogSupplier, Category, FieldValue, InventoryPart, LabelFields, OcrLine, Spec, Supplier } from '../shared/types.ts';
import { createLiveBarcodeReader, readBarcodes } from './barcodes.ts';
import { parseLiveProductBarcode } from '../shared/labels.ts';
import { createReceipt } from './receiving.ts';
import { HARDWARE_CATEGORIES, SPEC_TEMPLATES, THREADED, UNASSIGNED_DRAWER, categoryLabel, cleanHardwareSpecs, isHardwareCategory, isUnassigned, type SpecField, type ThreadSystem } from '../shared/hardware.ts';

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
function show(...nodes: (Node | null | false)[]) {
  stopLiveScan?.();
  $view().replaceChildren(...(nodes.filter(Boolean) as Node[]));
  window.scrollTo(0, 0);
}
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
function signOut() { stopLiveScan?.(); token = ''; member = ''; safeSet('token', ''); safeSet('member', ''); renderLogin(); }

async function renderLogin() {
  document.getElementById('tabs')!.hidden = true;
  document.getElementById('signout')!.hidden = true;
  const status = await api('/api/status').catch(() => null);
  const name = h('input', { autocomplete: 'username', placeholder: 'Your name' }) as HTMLInputElement;
  // Full keyboard (letters and digits), still masked. Sent as typed: "0042" stays "0042".
  const pin = h('input', { type: 'password', inputmode: 'text', autocomplete: 'current-password', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'Team PIN or passcode' }) as HTMLInputElement;
  const msg = h('div');
  show(h('div', { class: 'card' },
    h('h2', {}, 'Team sign-in'),
    h('p', { class: 'muted' }, 'Only team members can save parts or change stock.'),
    status?.demoMembers ? h('div', { class: 'notice warn' }, 'Demo server: sign in as "Demo One" / 1111 or "Demo Two" / 2222.') : null,
    h('label', {}, 'Name'), name, h('label', {}, 'PIN or passcode'), pin, msg,
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
let stopLiveScan: (() => void) | undefined;
window.addEventListener('pagehide', () => stopLiveScan?.());

function renderScan() {
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: (e: Event) => onPhoto(e) }) as HTMLInputElement;
  const upload = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e: Event) => onPhoto(e) }) as HTMLInputElement;
  cameraInput = camera;
  show(h('div', { class: 'card' },
    h('h2', {}, 'Scan a package'),
    h('p', { class: 'muted' }, 'Photograph the Mouser, DigiKey or McMaster-Carr label flat and in focus. Nothing is saved and stock is not changed until you confirm.'),
    camera, upload,
    h('button', { class: 'primary big', onclick: renderLiveScan }, 'Scan barcode'),
    h('button', { class: 'big', onclick: () => camera.click() }, 'Take photo'),
    h('button', { class: 'big', onclick: () => upload.click() }, 'Upload photo'),
    h('button', { class: 'big', onclick: () => renderReview({ ocrText: '', barcodes: [], fields: {}, requestId: uuid() }) }, 'Enter part number'),
  ), h('div', { class: 'card' },
    h('h2', {}, 'Mechanical hardware'),
    h('p', { class: 'muted' }, 'Screws, bolts, nuts, washers, pins, manifolds and other loose hardware. A supplier part number and drawer are optional.'),
    h('button', { class: 'big', onclick: () => renderHardware({ requestId: uuid() }) }, 'Add hardware'),
  ));
}

async function renderLiveScan() {
  const supplier = h('select', { 'aria-label': 'Barcode supplier' },
    h('option', { value: '' }, 'Detect automatically'),
    h('option', { value: 'mouser' }, 'Mouser'), h('option', { value: 'digikey' }, 'DigiKey')) as HTMLSelectElement;
  const video = h('video', { autoplay: true, playsinline: true, 'aria-label': 'Live rear-camera preview' }) as HTMLVideoElement;
  video.muted = true;
  const preview = h('div', { class: 'barcode-preview', hidden: true }, video,
    h('div', { class: 'barcode-guide', 'aria-hidden': 'true' }));
  const status = h('p', { class: 'muted', role: 'status' }, 'Starting camera…');
  show(h('div', { class: 'card' }, h('h2', {}, 'Scan barcode'),
    h('label', {}, 'Supplier'), supplier, preview, status,
    h('button', { class: 'big', onclick: retake }, 'Take a photo instead'),
    h('button', { class: 'big', onclick: renderScan }, 'Cancel')));

  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = window.isSecureContext ? 'Live camera is unavailable on this device.' : 'Open the app over HTTPS to use the live camera.';
    return;
  }

  let stream: MediaStream | undefined;
  let timer: number | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    if (stopLiveScan === stop) stopLiveScan = undefined;
  };
  const fail = (message: string) => {
    stop();
    preview.hidden = true;
    status.textContent = message;
  };
  stopLiveScan = stop;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 },
    } });
    if (stopped) { stop(); return; }
    video.srcObject = stream;
    preview.hidden = false;
    await video.play();
    if (stopped) return;
    preview.style.maxWidth = `${52 * video.videoWidth / video.videoHeight}vh`;
    const readFrame = await createLiveBarcodeReader(video);
    if (stopped) return;
    status.textContent = 'Center one product barcode inside the guide.';

    const scan = () => {
      if (stopped) return;
      try {
        const text = readFrame();
        if (text) {
          const fields = parseLiveProductBarcode(text, (supplier.value || undefined) as CatalogSupplier | undefined);
          if (fields) {
            stop();
            renderReview({ ocrText: '', barcodes: [{ text }], fields, requestId: uuid() });
            return;
          }
          status.textContent = 'Try the barcode next to the part number, or choose the supplier above.';
        }
        timer = window.setTimeout(scan, 200);
      } catch {
        fail('Couldn’t read the live camera. Try taking a photo.');
      }
    };
    scan();
  } catch (error) {
    if (!stopped) fail(error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'Camera access was denied. Allow it in your browser or take a photo.'
      : 'Couldn’t start the live scanner. Try taking a photo.');
  }
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
  let fields = await api<LabelFields>('/api/parse', { body: { text: ocrRes.text, barcodes, lines } });
  let ocrText = ocrRes.text;
  // McMaster labels have no part-number barcode to cross-check, so an unclear read gets a few more OCR passes
  // of the same photo at other sizes and contrast; the server keeps only what the passes agree on.
  if (fields.supplier?.value === 'mcmaster' && (fields.partNumberStatus !== 'ok' || !fields.description)) {
    status.textContent = 'McMaster label: reading it again at other sizes to confirm the part number…';
    bar.style.width = '0%';
    const extra = await ocrMany(EXTRA_PASSES.map(([side, mode]) => variant(img, side, mode)), (p) => { bar.style.width = `${Math.round(p * 100)}%`; })
      .catch((err) => { console.warn('extra OCR', err); return [] as string[]; });
    if (extra.length) {
      fields = await api<LabelFields>('/api/parse', { body: { text: ocrRes.text, altTexts: extra, barcodes, lines } });
      ocrText = [ocrRes.text, ...extra].map((t, i) => `--- read ${i + 1} ---\n${t}`).join('\n');
    }
  }
  renderReview({ photoUrl, ocrText, barcodes, fields, requestId: uuid() });
}

/** Extra McMaster passes: [long side in px, preprocessing]. Plain grey and min-channel (drops the yellow tag). */
const EXTRA_PASSES: [number, 'gray' | 'min'][] = [[1100, 'gray'], [1500, 'gray'], [1900, 'gray'], [1100, 'min'], [1500, 'min'], [1900, 'min']];

function variant(img: HTMLImageElement, side: number, mode: 'gray' | 'min'): HTMLCanvasElement {
  const scale = side / Math.max(img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const [r, g, b] = [d.data[i], d.data[i + 1], d.data[i + 2]];
    const y = mode === 'min' ? Math.min(255, Math.min(r, g, b) * 1.3) : 0.299 * r + 0.587 * g + 0.114 * b;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = y;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

async function ocrMany(canvases: HTMLCanvasElement[], onProgress: (p: number) => void): Promise<string[]> {
  const T = await loadTesseract();
  let done = 0;
  const worker = await T.createWorker('eng', 1, { logger: (m: any) => { if (m.status === 'recognizing text') onProgress((done + m.progress) / canvases.length); } });
  try {
    const out: string[] = [];
    for (const c of canvases) { out.push(String((await worker.recognize(c)).data.text)); done++; }
    return out;
  } finally { await worker.terminate(); }
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
function loadTesseract(): Promise<any> {
  tesseractLoad ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL; s.onload = () => ok((window as any).Tesseract); s.onerror = () => { tesseractLoad = undefined; fail(new Error('could not load OCR engine (offline?)')); };
    document.head.append(s);
  });
  return tesseractLoad;
}

async function ocr(canvas: HTMLCanvasElement, onProgress: (p: number) => void): Promise<{ text: string; lines: OcrLine[] }> {
  const T = await loadTesseract();
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
    h('button', { class: 'link', onclick: () => { input.value = opts.guess!; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); } }, 'Use it anyway')) : null;
  return { node: h('div', {}, h('label', {}, label, sourceNote(f)), input, hint), input };
}

async function renderReview(st: ScanState) {
  const f = st.fields;
  // McMaster-Carr has no catalog lookup yet: its labels go straight to the editable hardware form.
  if (f.supplier?.value === 'mcmaster') return renderHardware({ requestId: st.requestId, scan: st });
  const supplier = h('select', { 'aria-label': 'Supplier' }, h('option', { value: '' }, 'Choose supplier…'), h('option', { value: 'mouser' }, 'Mouser'), h('option', { value: 'digikey' }, 'DigiKey'), h('option', { value: 'mcmaster' }, 'McMaster-Carr (hardware)')) as HTMLSelectElement;
  supplier.value = f.supplier?.value ?? '';
  supplier.addEventListener('change', () => {
    if (supplier.value !== 'mcmaster') return;
    const typed = (fv: FieldValue | undefined, v: string) => (v.trim() ? { value: v.trim(), source: 'manual' as const, confidence: 1 } : fv);
    renderHardware({ requestId: st.requestId, scan: { ...st, fields: { ...f, supplier: { value: 'mcmaster', reason: 'chosen by user' }, sku: typed(f.sku, sku.input.value), description: typed(f.description, desc.input.value) } } });
  });
  const sku = fieldInput('Supplier part number (SKU)', f.sku, { pn: true, guess: f.guesses?.sku });
  const mpn = fieldInput('Manufacturer part number', f.mpn, { pn: true, guess: f.guesses?.mpn });
  const mfr = fieldInput('Manufacturer', f.manufacturer);
  const desc = fieldInput('Description', f.description);
  const qty = fieldInput('Printed quantity', f.quantity, { numeric: true });
  const out = h('div');
  const confident = f.partNumberStatus === 'ok' && !!f.supplier && !!(f.sku || f.mpn);
  const editor = h('fieldset', {}, supplier, sku.node, mpn.node, mfr.node, desc.node, qty.node) as HTMLFieldSetElement;
  let lookupVersion = 0;
  const corrections = h('details', { open: !confident }, h('summary', {}, 'Part number and label details'), editor) as HTMLDetailsElement;
  const title = h('h2', {}, confident ? 'Review and receive' : st.photoUrl ? 'Check what was read' : 'Enter part number');
  const lockReview = () => { editor.disabled = true; lookupBtn.disabled = true; };

  const lookup = async () => {
    if (!supplier.value) { out.replaceChildren(h('div', { class: 'notice warn' }, 'Choose the supplier first.')); return; }
    if (!sku.input.value.trim() && !mpn.input.value.trim()) { out.replaceChildren(h('div', { class: 'notice warn' }, 'Enter the SKU or manufacturer part number first.')); return; }
    const version = ++lookupVersion;
    lookupBtn.disabled = true;
    const label = { supplier: supplier.value as Supplier, sku: sku.input.value.trim(), mpn: mpn.input.value.trim(), manufacturer: mfr.input.value.trim(), description: desc.input.value.trim(), printedQty: qty.input.value.trim() };
    out.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'Looking up catalog…'));
    try {
      const r = await api('/api/identify', { body: label });
      if (version !== lookupVersion || !out.isConnected) return;
      out.replaceChildren(renderIdentify(r, st, label, lockReview));
      corrections.open = r.status !== 'matched';
      title.textContent = r.status === 'matched' ? 'Review and receive' : 'Choose or correct the part';
    } catch (e) {
      if (version === lookupVersion && out.isConnected) {
        corrections.open = true;
        out.replaceChildren(h('div', { class: 'notice bad', role: 'alert' }, (e as Error).message));
      }
    } finally { if (version === lookupVersion) lookupBtn.disabled = false; }
  };
  const lookupBtn = h('button', { class: 'primary big', onclick: lookup }, 'Look up in catalog') as HTMLButtonElement;
  editor.prepend(h('label', {}, 'Supplier', f.supplier ? h('span', { class: 'src' }, ` (${f.supplier.reason})`) : null));
  editor.append(lookupBtn);
  const invalidate = () => {
    lookupVersion++;
    lookupBtn.disabled = false;
    out.replaceChildren(h('p', { class: 'notice warn' }, 'Part details changed. Look up the corrected part before receiving.'));
  };
  for (const input of [supplier, sku.input, mpn.input, mfr.input, desc.input, qty.input]) input.addEventListener('input', invalidate);

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
          h('button', { onclick: () => { sku.input.value = t; invalidate(); } }, 'SKU'), h('button', { onclick: () => { mpn.input.value = t; invalidate(); } }, 'MPN'),
          /^\d+$/.test(t) ? h('button', { onclick: () => { qty.input.value = t; invalidate(); } }, 'Qty') : null)))
    : null;
  if (unassigned) editor.append(unassigned);

  show(
    photoBlock(st.photoUrl),
    h('div', { class: 'card' },
      title,
      unreadable,
      corrections,
      st.photoUrl ? h('details', {}, h('summary', {}, 'Raw OCR text and barcodes'),
        h('pre', { class: 'mono muted', style: 'white-space:pre-wrap' }, st.ocrText || '(no text)'),
        h('p', { class: 'muted' }, st.barcodes.length ? `Barcodes decoded: ${st.barcodes.map((b) => b.text).join(' | ')}` : 'No barcodes decoded.')) : null,
      out,
      h('button', { class: 'big', onclick: renderScan }, 'Start over'),
    ),
  );
  if (confident) await lookup();
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

type ReviewPart = WithSummary<CatalogPart> & { existing?: Pick<InventoryPart, 'partId' | 'locations'> };

function renderIdentify(r: any, st: ScanState, label: LabelInfo, lockReview: () => void): HTMLElement {
  const box = h('div');
  const statusBadge = r.status === 'matched' ? h('span', { class: 'badge ok' }, 'Exact match') : r.status === 'review' ? h('span', { class: 'badge warn' }, 'Needs review') : h('span', { class: 'badge bad' }, 'Not found');
  const head = h('div', { class: 'card' }, h('h2', {}, 'Catalog result ', statusBadge),
    h('p', { class: 'muted' }, `Catalog data: ${r.catalogMode.primary === 'live' ? 'live API' : 'DEMO data'} (${label.supplier})`),
    ...r.reasons.map((x: string) => h('div', { class: 'notice warn' }, x)));
  box.append(head);

  if (r.status === 'not_found') {
    box.append(manualPartForm(st, label, lockReview));
    return box;
  }
  const detail = h('div');
  const choices = h('fieldset') as HTMLFieldSetElement;
  const lock = () => { choices.disabled = true; lockReview(); };
  const pick = (part: ReviewPart) => detail.replaceChildren(partReview(part, r.crossSku, r.gapFill, st, label, lock));
  if (r.status === 'review' && r.candidates.length) {
    choices.append(h('legend', {}, 'Choose the exact part'), ...r.candidates.map((c: any) => {
      const radio = h('input', { type: 'radio', name: 'cand', onchange: () => pick(c.part) }) as HTMLInputElement;
      return h('label', { class: 'cand' }, radio, h('div', {},
        h('div', { class: 'mono' }, c.part.mpn), h('div', { class: 'muted' }, `${c.part.manufacturer} · ${c.part.sku}`),
        h('div', {}, c.mpnMatch === false ? h('span', { class: 'badge bad' }, 'MPN differs') : c.mpnMatch ? h('span', { class: 'badge ok' }, 'MPN matches') : null,
          c.manufacturerMatch === false ? h('span', { class: 'badge bad' }, 'Manufacturer differs') : c.manufacturerMatch ? h('span', { class: 'badge ok' }, 'Manufacturer matches') : null),
        h('div', { class: 'muted' }, c.part.description)));
    }), h('button', { class: 'link', onclick: () => detail.replaceChildren(manualPartForm(st, label, lock)) }, 'None of these – enter manually'));
    head.append(choices);
  }
  if (r.status === 'matched' && r.chosen) pick(r.chosen);
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
  const input = h('input', { 'aria-label': 'Drawer (optional)', list: id, placeholder: 'e.g. A3 – leave blank if not in a drawer', autocapitalize: 'characters' }) as HTMLInputElement;
  const dl = h('datalist', { id });
  api<string[]>('/api/drawers').then((ds) => dl.replaceChildren(...ds.map((d) => h('option', { value: d })))).catch(() => {});
  return { node: h('div', {}, h('label', {}, 'Drawer (optional)'), input, dl), input };
}

/** "A3" -> "A3"; blank or whitespace -> "Not specified" (the part's single unassigned location). */
const drawerName = (d: string) => (isUnassigned(d) ? UNASSIGNED_DRAWER : d.trim().replace(/\s+/g, ' '));
const savedWhere = (d: string) => (isUnassigned(d) ? 'with drawer Not specified' : `in drawer ${drawerName(d)}`);

function partReview(part: ReviewPart, crossSku: any, gapFill: any, st: ScanState, label: LabelInfo, lockReview: () => void) {
  const manual = manualSpecsEditor();
  const sku = label.sku && [part.sku, ...part.altSkus].some((s) => s.toUpperCase() === label.sku.toUpperCase()) ? label.sku : part.sku;
  return h('div', { class: 'card' },
    h('h2', { class: 'mono' }, part.mpn),
    h('div', {}, part.manufacturer, ' · ', h('span', { class: 'badge' }, part.category), part.origin === 'demo' ? h('span', { class: 'badge warn' }, 'demo data') : h('span', { class: 'badge ok' }, 'live')),
    h('p', { class: 'muted' }, part.description),
    h('p', { class: 'muted' }, `${part.supplier}: `, h('span', { class: 'mono' }, part.sku), crossSku ? ` · also ${crossSku.supplier}: ` : '', crossSku ? h('span', { class: 'mono' }, crossSku.sku) : ''),
    gapFill ? h('p', { class: 'muted' }, gapFill.addedKeys?.length ? `Filled ${gapFill.addedKeys.length} specs from ${gapFill.supplier} (exact manufacturer + MPN match).` : `${gapFill.supplier} not used: ${gapFill.rejected ?? 'nothing to add'}.`) : null,
    part.existing ? h('div', { class: 'notice ok' }, h('strong', {}, 'Already in inventory'),
      ...part.existing.locations.map((l) => h('div', {}, `${drawerName(l.drawer)}: ${l.qty === null ? 'not counted' : l.qty}`))) : null,
    receivingForm(() => ({ ...part, sku }), st, label, lockReview, part.existing?.partId, part.existing ? undefined : manual, crossSku),
    h('details', {}, h('summary', {}, 'Part specs and links'), summaryList(part.summary), specTable(part.specs), links(part)));
}

/** Count, location, and action stay together. Failed writes keep their original intent for a safe retry. */
function receivingForm(part: () => CatalogPart, st: ScanState, label: LabelInfo, lockReview: () => void,
  existingId?: string, manual?: ReturnType<typeof manualSpecsEditor>, crossSku?: { supplier: string; sku: string }) {
  const drawer = drawerPicker();
  const count = h('input', { 'aria-label': 'Counted quantity', inputmode: 'numeric', placeholder: 'Count the pieces you are adding' }) as HTMLInputElement;
  const note = h('input', { 'aria-label': 'Stock note (optional)', placeholder: 'e.g. opened bag, checked by Alex' }) as HTMLInputElement;
  const msg = h('div', { 'aria-live': 'polite' });
  const receipt = createReceipt((path, body) => api(path, { body }), st.requestId, uuid(), existingId);
  const controls = h('fieldset', {},
    h('legend', {}, 'Receive this bag'),
    h('label', {}, 'Counted quantity'), count,
    h('p', { class: 'muted' }, label.printedQty ? `Printed quantity: ${label.printedQty} (suggestion only). Count what is actually in this bag, then confirm below.` : 'Count what is actually in this bag, then confirm below.'),
    label.printedQty ? h('button', { onclick: () => { count.value = label.printedQty; count.focus(); } }, `Use ${label.printedQty}`) : null,
    drawer.node, h('label', {}, 'Stock note (optional)'), note,
    manual ? h('details', {}, h('summary', {}, 'Add or correct specs'), manual.node) : null) as HTMLFieldSetElement;
  let busy = false;
  let mode: boolean | undefined;
  const addBtn = h('button', { class: 'primary big', onclick: () => submit(mode ?? true) }, existingId ? 'Add stock' : 'Save and add stock') as HTMLButtonElement;
  const onlyBtn = h('button', { class: 'big', onclick: () => submit(false) }, 'Save part only') as HTMLButtonElement;
  const submit = async (addStock: boolean) => {
    if (busy) return;
    busy = true; addBtn.disabled = true; onlyBtn.disabled = true;
    try {
      const result = receipt.submit({ part: part(), count: count.value, drawer: drawer.input.value, note: note.value, manualSpecs: manual?.read(), crossSku }, addStock);
      mode = addStock;
      controls.disabled = true;
      lockReview();
      msg.replaceChildren(h('p', { role: 'status' }, addStock ? 'Saving and adding stock…' : 'Saving part…'));
      const r = await result;
      msg.replaceChildren(h('div', { class: 'notice ok', role: 'status' },
        r.count === undefined ? `Saved part ${savedWhere(r.drawer)}. No stock added.` : `Added ${r.count} to drawer ${r.drawer}. Current count: ${r.balance}.${r.duplicate ? ' This operation was already recorded; no extra stock was added.' : ''}`),
        h('button', { class: 'primary big', onclick: renderLiveScan }, 'Scan next'),
        h('button', { class: 'big', onclick: renderScan }, 'Other entry options'),
        h('button', { class: 'link', onclick: () => renderPart(r.partId) }, 'View inventory part'));
      addBtn.textContent = 'Done';
      msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      const message = !receipt.started ? '' : mode
        ? `${receipt.partId ? 'Part is saved. Stock addition could not be confirmed.' : 'Part save could not be confirmed.'} Retry the same operation below; the count, drawer and note are retained.`
        : 'Part save could not be confirmed. Retry the same save below.';
      msg.replaceChildren(h('div', { class: 'notice bad', role: 'alert' }, message, h('div', {}, (e as Error).message)));
      addBtn.disabled = false;
      onlyBtn.disabled = receipt.started;
      if (receipt.started) addBtn.textContent = mode ? (receipt.partId ? 'Retry add stock' : 'Retry save and add stock') : 'Retry save part only';
    } finally { busy = false; }
  };
  return h('div', {}, controls, addBtn, existingId ? null : onlyBtn, msg);
}

function manualPartForm(st: ScanState, label: LabelInfo, lockReview: () => void) {
  const mfr = h('input', { value: label.manufacturer }) as HTMLInputElement;
  const mpn = h('input', { value: label.mpn, class: 'pn' }) as HTMLInputElement;
  const desc = h('input', { value: label.description }) as HTMLInputElement;
  const cat = h('select', {}, ...['capacitor', 'resistor', 'inductor', 'ic', 'connector', 'other'].map((c) => h('option', { value: c }, c))) as HTMLSelectElement;
  const ds = h('input', { placeholder: 'https://…' }) as HTMLInputElement;
  const manual = manualSpecsEditor();
  const fields = h('fieldset', {}, h('legend', {}, 'Enter part manually'),
    h('label', {}, 'Manufacturer'), mfr, h('label', {}, 'Manufacturer part number'), mpn, h('label', {}, 'Description'), desc,
    h('label', {}, 'Category'), cat, h('label', {}, 'Datasheet link'), ds) as HTMLFieldSetElement;
  return h('div', { class: 'card' },
    fields,
    receivingForm(() => ({ supplier: label.supplier, sku: label.sku, manufacturer: mfr.value, mpn: mpn.value, description: desc.value, category: cat.value, datasheetUrl: ds.value, specs: [], altSkus: [], origin: 'demo' }),
      st, label, () => { fields.disabled = true; lockReview(); }, undefined, manual));
}

/**
 * Optional step after saving. Suggests the printed quantity but requires the member to type the real count.
 * `labelNote` replaces the default wording, e.g. McMaster's "ordered 2, shipped 2".
 */
function receiveStock(partId: string, drawerInput: string, printed: string, labelNote?: string) {
  const requestId = uuid();
  const drawer = drawerName(drawerInput);
  const count = h('input', { inputmode: 'numeric', 'aria-label': 'Counted quantity', placeholder: printed ? `Label: ${printed} – type your count` : 'Count' }) as HTMLInputElement;
  const msg = h('div');
  return h('div', { class: 'card' },
    h('h3', {}, 'Add stock to ', h('span', { class: 'badge drawer' }, drawer), ' (optional)'),
    h('p', { class: 'muted' }, labelNote ?? (printed ? `The label says ${printed}. Old bags may be open – count what is actually inside.` : 'Count what is in the bag.')),
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

// ---------- hardware ----------
interface HardwareOpts { requestId: string; scan?: ScanState }

/** "5/16 in" -> { num: "5/16", unit: "in" }; "8 mm" -> { num: "8", unit: "mm" }. */
function splitLength(v: string, fallback: 'mm' | 'in'): { num: string; unit: 'mm' | 'in' } {
  const m = /^\s*(.+?)\s*(mm|in\.?|inch(?:es)?|"|”)\s*$/i.exec(v ?? '');
  return m ? { num: m[1], unit: /mm/i.test(m[2]) ? 'mm' : 'in' } : { num: v ?? '', unit: fallback };
}

function selectOf(label: string, options: [string, string][], value = '') {
  const s = h('select', { 'aria-label': label }, ...options.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  s.value = value;
  return s;
}

/**
 * Add hardware by hand, or review a McMaster-Carr label. Part name and category are required; supplier, part
 * number, link, specs and drawer are optional. Nothing is saved, and stock is not changed, until the member confirms.
 */
function renderHardware(opts: HardwareOpts) {
  const st = opts.scan;
  const f: LabelFields = st?.fields ?? {};
  const fromLabel = f.supplier?.value === 'mcmaster' && !!st?.photoUrl;
  const info = f.mcmaster;
  const suggested = f.hardware?.specs ?? [];

  const name = h('input', { 'aria-label': 'Part name', value: f.description?.value ?? '', placeholder: 'e.g. M3 x 8 mm socket head screw' }) as HTMLInputElement;
  const cat = selectOf('Category', [['', 'Choose category…'], ...HARDWARE_CATEGORIES.map((c) => [c.value, c.label] as [string, string])], f.hardware?.category ?? '');
  const supplier = selectOf('Supplier', [['', 'None / not known'], ['mcmaster', 'McMaster-Carr'], ['mouser', 'Mouser'], ['digikey', 'DigiKey']], f.supplier?.value === 'mcmaster' ? 'mcmaster' : '');
  const sku = fieldInput('Supplier part number (optional)', f.sku, { pn: true, guess: f.guesses?.sku });
  sku.input.placeholder = 'e.g. 31335A12';
  const link = h('input', { 'aria-label': 'Product link', placeholder: 'https://… (optional)', inputmode: 'url', autocapitalize: 'off' }) as HTMLInputElement;
  const mcLink = h('button', { class: 'link', onclick: () => { if (sku.input.value.trim()) link.value = `https://www.mcmaster.com/${encodeURIComponent(sku.input.value.trim().toUpperCase())}/`; } }, 'Use the McMaster-Carr product page');
  const desc = h('input', { 'aria-label': 'Description', value: f.description?.value ?? '', placeholder: 'Optional, e.g. the label description' }) as HTMLInputElement;
  const firstThread = suggested.find((s) => /^thread size$/i.test(s.name))?.value ?? '';
  const system = selectOf('Thread system', [['metric', 'Metric (M3, pitch in mm)'], ['imperial', 'Imperial (#4, 1/4", threads per inch)']],
    /^M/i.test(firstThread) || !firstThread ? 'metric' : 'imperial');
  const systemRow = h('div', {}, h('label', {}, 'Thread system'), system);

  // Template spec fields for the chosen category. Values survive switching category or thread system.
  const values = new Map<string, string>();
  for (const s of suggested) values.set(/^(thread pitch|threads per inch)$/i.test(s.name) ? 'Pitch' : s.name, s.value);
  const specBox = h('div');
  const extras = h('div');
  let readers: (() => { name: string; value: string } | undefined)[] = [];

  const addExtra = (n = '', v = '') => {
    const nIn = h('input', { 'aria-label': 'Spec name', value: n, placeholder: 'Spec name, e.g. Finish' }) as HTMLInputElement;
    const vIn = h('input', { 'aria-label': 'Spec value', value: v, placeholder: 'Value' }) as HTMLInputElement;
    const row = h('div', { class: 'row', 'data-extra': '1', style: 'margin:4px 0' }, nIn, vIn, h('button', { 'aria-label': 'Remove spec', onclick: () => row.remove() }, '×'));
    extras.append(row);
  };
  const templateNames = (c: string) => new Set((SPEC_TEMPLATES[c] ?? []).map((t) => t.name.toLowerCase()));
  for (const s of suggested) {
    const key = /^(thread pitch|threads per inch)$/i.test(s.name) ? 'pitch' : s.name.toLowerCase();
    if (!templateNames(f.hardware?.category ?? '').has(key)) addExtra(s.name, s.value);
  }

  const renderSpecs = () => {
    for (const r of readers) { const v = r(); if (v) values.set(v.name === 'Thread pitch' || v.name === 'Threads per inch' ? 'Pitch' : v.name, v.value); }
    const c = cat.value;
    const sys = system.value as ThreadSystem;
    systemRow.hidden = !THREADED.includes(c as Category);
    readers = [];
    const rows: HTMLElement[] = [];
    for (const t of SPEC_TEMPLATES[c] ?? []) rows.push(specInput(t, sys));
    specBox.replaceChildren(...(c ? [h('h3', {}, `${categoryLabel(c)} specs`), ...rows] : [h('p', { class: 'muted' }, 'Choose a category to see the usual specs.')]));
  };
  const specInput = (t: SpecField, sys: ThreadSystem): HTMLElement => {
    const prev = values.get(t.name) ?? '';
    if (t.kind === 'length') {
      // Empty length fields default to the unit already used on this part (a 5/16" pin is probably measured in inches).
      const usedInch = [...values.values()].some((v) => /^\s*[\d./ -]+\s*(in|"|inch)/i.test(v));
      const { num, unit } = splitLength(prev, sys === 'imperial' || usedInch ? 'in' : 'mm');
      const n = h('input', { 'aria-label': t.name, value: num, inputmode: 'decimal', placeholder: unit === 'mm' ? 'e.g. 8' : 'e.g. 1/2 or 0.5' }) as HTMLInputElement;
      const u = selectOf(`${t.name} unit`, [['mm', 'mm'], ['in', 'in']], unit);
      u.style.maxWidth = '84px';
      readers.push(() => (n.value.trim() ? { name: t.name, value: `${n.value.trim()} ${u.value}` } : undefined));
      return h('div', {}, h('label', {}, t.name), h('div', { class: 'row' }, n, u));
    }
    if (t.kind === 'pitch') {
      const label = sys === 'imperial' ? 'Threads per inch' : 'Thread pitch (mm)';
      const i = h('input', { 'aria-label': label, value: prev.replace(/\s*(mm|tpi)$/i, ''), inputmode: 'decimal', placeholder: sys === 'imperial' ? 'e.g. 20' : 'e.g. 0.5' }) as HTMLInputElement;
      readers.push(() => (i.value.trim() ? (sys === 'imperial' ? { name: 'Threads per inch', value: i.value.trim() } : { name: 'Thread pitch', value: `${i.value.trim().replace(/\s*mm$/i, '')} mm` }) : undefined));
      return h('div', {}, h('label', {}, label), i);
    }
    const ph = t.kind === 'thread' ? (sys === 'imperial' ? 'e.g. #4 or 1/4"' : 'e.g. M3') : t.placeholder ?? '';
    const i = h('input', { 'aria-label': t.name, value: prev, placeholder: ph, inputmode: t.kind === 'int' ? 'numeric' : undefined, autocapitalize: t.kind === 'thread' ? 'characters' : undefined }) as HTMLInputElement;
    readers.push(() => (i.value.trim() ? { name: t.name, value: i.value.trim() } : undefined));
    return h('div', {}, h('label', {}, t.name), i);
  };
  cat.addEventListener('change', renderSpecs);
  system.addEventListener('change', renderSpecs);
  renderSpecs();

  const readSpecs = () => [
    ...readers.map((r) => r()).filter((x): x is { name: string; value: string } => !!x),
    ...[...extras.querySelectorAll('[data-extra]')].map((row) => {
      const [n, v] = [...row.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value.trim());
      return { name: n, value: v };
    }).filter((x) => x.name && x.value),
  ];

  // Same hardware already in inventory? Offer it, so members add stock to it instead of creating a duplicate.
  const matches = h('div');
  let timer: number | undefined;
  const findExisting = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const q = sku.input.value.trim() || name.value.trim();
      if (q.length < 3) { matches.replaceChildren(); return; }
      try {
        const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
        const hits = (r.hits as any[]).filter((x) => isHardwareCategory(x.part.category)).slice(0, 3);
        const exact = hits.some((x) => x.part.skus.some((s: any) => s.sku.toUpperCase() === sku.input.value.trim().toUpperCase()));
        matches.replaceChildren(...(hits.length ? [h('div', { class: exact ? 'notice ok' : 'notice warn' },
          h('strong', {}, exact ? 'This part number is already in inventory.' : 'Similar hardware already in inventory'),
          h('div', { class: 'src' }, exact ? 'Saving updates its record and never changes stock. Or open it to add stock or a drawer.' : 'Adding more of the same? Open it and add stock there instead of creating a new part.'),
          ...hits.map((x) => h('div', { class: 'row', style: 'margin-top:6px' },
            h('div', {}, h('div', {}, x.part.name || x.part.mpn), h('div', { class: 'src mono' }, x.part.skus[0]?.sku ?? x.part.partId), drawerBadges(x.part)),
            h('button', { onclick: () => renderPart(x.part.partId) }, 'Use this part'))))] : []));
      } catch { /* search is only a hint */ }
    }, 400);
  };
  name.addEventListener('input', findExisting);
  sku.input.addEventListener('input', findExisting);
  if (name.value || sku.input.value) findExisting();

  const drawer = drawerPicker();
  const msg = h('div');
  const saveBtn = h('button', { class: 'primary big' }, 'Save to inventory') as HTMLButtonElement;
  saveBtn.onclick = async () => {
    const c = cat.value as Category;
    if (!name.value.trim()) { msg.replaceChildren(h('div', { class: 'notice warn' }, 'Enter a part name.')); name.focus(); return; }
    if (!c) { msg.replaceChildren(h('div', { class: 'notice warn' }, 'Choose a category.')); cat.focus(); return; }
    if (sku.input.value.trim() && !supplier.value) { msg.replaceChildren(h('div', { class: 'notice warn' }, 'Choose the supplier for that part number, or clear it.')); supplier.focus(); return; }
    const threadSystem = THREADED.includes(c) ? (system.value as ThreadSystem) : undefined;
    const specs = readSpecs();
    const check = cleanHardwareSpecs(c, threadSystem, specs);
    if ('error' in check) { msg.replaceChildren(h('div', { class: 'notice warn' }, check.error)); return; }
    saveBtn.disabled = true;
    msg.replaceChildren(h('p', { class: 'muted' }, 'Saving…'));
    try {
      const r = await api('/api/hardware', { body: {
        requestId: opts.requestId, name: name.value.trim(), category: c, supplier: supplier.value || undefined, sku: sku.input.value.trim(),
        productUrl: link.value.trim(), description: desc.value.trim(), threadSystem, specs, drawer: drawer.input.value,
        specSource: fromLabel ? 'McMaster-Carr label (photo), checked by member' : undefined,
      } });
      const shown = r.part?.skus?.[0]?.sku ? `${r.part.skus[0].sku}` : r.partId;
      const note = info?.ordered || info?.shipped
        ? `The label says ${info.ordered ?? '?'} ordered and ${info.shipped ?? '?'} shipped. Shipments can differ from what is in the bag – count it and type the real number.`
        : undefined;
      msg.replaceChildren(
        h('div', { class: 'notice ok' }, `${r.created ? 'Saved new part' : 'Updated existing part'} ${savedWhere(drawer.input.value)}. `,
          h('div', {}, 'Inventory ID: ', h('span', { class: 'badge mono' }, r.partId), r.partId !== shown ? h('span', { class: 'src' }, ` · ${shown}`) : null)),
        receiveStock(r.partId, drawer.input.value, info?.shipped ?? '', note));
      saveBtn.textContent = 'Saved';
    } catch (e) {
      saveBtn.disabled = false; // same requestId on retry, so a double save is harmless
      msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message));
    }
  };

  const guess = f.guesses?.sku && /^\d{3,5}[A-Z]\d{1,4}$/.test(f.guesses.sku) ? f.guesses.sku : undefined;
  const unreadable = fromLabel && f.partNumberStatus === 'unreadable' && guess
    ? h('div', { class: 'notice warn', role: 'alert' },
        h('strong', {}, 'Part number not confirmed'),
        h('div', {}, 'The reads of this photo did not agree. The best guess is ', h('span', { class: 'mono' }, guess), ' – compare it with the label before using it.'),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'primary', onclick: () => { sku.input.value = guess; sku.input.dispatchEvent(new Event('input')); sku.input.focus(); } }, `Use ${guess}`),
          h('button', { onclick: retake }, 'Retake close-up')))
    : fromLabel && f.partNumberStatus === 'unreadable'
    ? h('div', { class: 'notice bad', role: 'alert' },
        h('strong', {}, 'Couldn’t read the McMaster part number'),
        h('div', {}, 'Type it from the label (it follows “Part Number”, e.g. 31335A12), or retake a closer photo. You can also save without one.'),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'primary', onclick: retake }, 'Retake close-up'),
          h('button', { onclick: () => { sku.input.focus(); sku.input.scrollIntoView({ block: 'center' }); } }, 'Enter part number')))
    : null;
  const labelInfo = fromLabel && info
    ? h('div', { class: 'notice warn' },
        h('div', {}, h('strong', {}, 'McMaster-Carr label'), ' – check each field against the photo.'),
        info.purchaseOrder || info.line ? h('div', { class: 'src' }, `Purchase order ${info.purchaseOrder ?? '?'} · line ${info.line ?? '?'} (not the part number, not saved)`) : null,
        info.ordered || info.shipped ? h('div', { class: 'src' }, `Label: ordered ${info.ordered ?? '?'}, shipped ${info.shipped ?? '?'}. You will count the bag after saving.`) : null)
    : null;

  show(
    photoBlock(st?.photoUrl),
    h('div', { class: 'card' },
      h('h2', {}, fromLabel ? 'Check the McMaster-Carr label' : 'Add hardware'),
      unreadable, labelInfo,
      h('label', {}, 'Part name', h('span', { class: 'src' }, ' (required)')), name,
      h('label', {}, 'Category', h('span', { class: 'src' }, ' (required)')), cat,
      h('label', {}, 'Supplier (optional)'), supplier,
      sku.node,
      h('label', {}, 'Product link (optional)'), link, mcLink,
      h('label', {}, 'Description (optional)'), desc,
      matches,
      systemRow, specBox,
      h('h3', {}, 'Other specs'), extras, h('button', { onclick: () => addExtra() }, '+ Add spec'),
      drawer.node,
      st?.photoUrl ? h('details', {}, h('summary', {}, 'Raw OCR text'), h('pre', { class: 'mono muted', style: 'white-space:pre-wrap' }, st.ocrText || '(no text)')) : null,
      saveBtn,
      h('button', { class: 'big', onclick: renderScan }, 'Start over'),
      msg),
  );
}

// ---------- search ----------
let lastQuery = '';
function renderSearch() {
  const q = h('input', { type: 'search', 'aria-label': 'Search inventory', placeholder: 'SKU, MPN, name, "M3 x 8 mm", drawer…', value: lastQuery, autocapitalize: 'off', autocorrect: 'off' }) as HTMLInputElement;
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
    h('p', { class: 'muted' }, 'Try a supplier or McMaster part number, a part name, "100 nF capacitor, at least 25 V, ±10% or tighter", a size like "M3 x 8 mm" or 5/16", a drawer like "drawer A3", or "not specified" for parts with no drawer.')), results);
  run();
}

function drawerBadges(p: InventoryPart) {
  if (!p.locations.length) return h('span', { class: 'badge unassigned' }, UNASSIGNED_DRAWER);
  return h('span', {}, ...p.locations.map((l) => h('span', { class: isUnassigned(l.drawer) ? 'badge unassigned' : 'badge drawer' }, drawerName(l.drawer), l.qty !== null ? ` × ${l.qty}` : '')));
}

function resultCard(hit: { part: WithSummary<InventoryPart>; checks: { ok: boolean; why: string }[] }) {
  const p = hit.part;
  const ids = [...p.skus.map((s) => s.sku), ...(p.skus.length ? [] : [p.partId])].join(' · ');
  return h('button', { class: 'result', onclick: () => renderPart(p.partId) },
    h('div', {}, drawerBadges(p)),
    p.name ? h('div', {}, p.name) : h('div', { class: 'mono' }, p.mpn),
    h('div', { class: 'muted' }, [p.manufacturer, isHardwareCategory(p.category) ? categoryLabel(p.category) : '', ids].filter(Boolean).join(' · ')),
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
      p.name ? h('h2', {}, p.name) : h('h2', { class: 'mono' }, p.mpn),
      h('div', {}, p.manufacturer ? `${p.manufacturer} · ` : '', h('span', { class: 'badge' }, categoryLabel(p.category)), p.name && p.mpn ? h('span', { class: 'mono' }, ` ${p.mpn}`) : null),
      h('p', { class: 'src' }, 'Inventory ID: ', h('span', { class: 'mono' }, p.partId)),
      p.description && p.description !== p.name ? h('p', { class: 'muted' }, p.description) : null,
      h('p', {}, ...p.skus.map((s: any) => h('span', { class: 'badge' }, `${s.supplier}: `, h('span', { class: 'mono' }, s.sku), s.onLabel ? '' : ' (catalog)'))),
      summaryList(p.summary), specTable(p.specs), links(p),
      p.skus.some((s: any) => s.supplier === 'mouser' || s.supplier === 'digikey')
        ? h('button', { onclick: async () => { try { await api(`/api/parts/${partId}/refresh`, { body: {} }); renderPart(partId); } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); } } }, 'Refresh catalog specs')
        : null),
    h('div', { class: 'card' }, h('h3', {}, 'Locations and stock'),
      ...(p.locations.length ? p.locations.map(stockRow) : [h('p', { class: 'muted' }, 'No location yet. Add one below – leave the drawer blank for "Not specified".')]), msg,
      newDrawer.node, h('button', { onclick: async () => {
        try {
          await api(`/api/parts/${partId}/locations`, { body: { requestId: uuid(), drawer: newDrawer.input.value } });
          renderPart(partId);
        } catch (e) { msg.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message)); }
      } }, 'Add location')),
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

/** Header link to the Google Sheet. Shown signed in or out, and only when the server uses a Google Sheet. */
function showSheetLink() {
  fetch('/api/status').then((r) => r.json()).then((s: { sheetUrl?: string }) => {
    const a = document.getElementById('sheetlink') as HTMLAnchorElement;
    if (typeof s.sheetUrl === 'string' && s.sheetUrl.startsWith('https://docs.google.com/spreadsheets/d/')) {
      a.href = s.sheetUrl;
      a.hidden = false;
    }
  }).catch(() => {});
}

showSheetLink();
if (token) start(); else renderLogin();
