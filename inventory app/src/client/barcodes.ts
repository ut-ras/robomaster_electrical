// Find and decode the barcodes on a bag photo, keeping each one's position so the parser can tell which
// field it belongs to. Works on iPhone (no native BarcodeDetector there) by using ZXing compiled to JS.
//
// 1. Locate barcode-like regions: strong horizontal gradient (vertical bars) and weak vertical gradient.
// 2. Decode each region with ZXing, trying small rotations, since bags are rarely photographed square.
// 3. Also try 2D codes (DataMatrix / QR) on square textured regions.

import type { BarcodeHit } from '../shared/types.ts';

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
let zxingLoad: Promise<any> | undefined;
function loadZxing(): Promise<any> {
  zxingLoad ??= new Promise((ok, fail) => {
    if ((window as any).ZXing) return ok((window as any).ZXing);
    const s = document.createElement('script');
    s.src = ZXING_URL; s.onload = () => ok((window as any).ZXing);
    s.onerror = () => { zxingLoad = undefined; s.remove(); fail(new Error('could not load barcode reader')); };
    document.head.append(s);
  });
  return zxingLoad;
}

/** Read the guide area of each camera frame with the same decoder used for photos. */
export async function createLiveBarcodeReader(video: HTMLVideoElement): Promise<() => string | undefined> {
  const Z = await loadZxing();
  const reader = new Z.MultiFormatReader();
  reader.setHints(new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.QR_CODE,
  ]]]));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not start the barcode reader');

  return () => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return undefined;
    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight) return undefined;
    // Keep this crop aligned with the on-screen guide in styles.css.
    const width = Math.round(videoWidth * 0.9);
    const height = Math.round(videoHeight * 0.52);
    const scale = Math.min(1, 1100 / Math.max(width, height));
    const targetWidth = Math.round(width * scale), targetHeight = Math.round(height * scale);
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    context.drawImage(video, (videoWidth - width) / 2, (videoHeight - height) / 2, width, height,
      0, 0, targetWidth, targetHeight);
    const source = new Z.HTMLCanvasElementLuminanceSource(canvas);
    try {
      return reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(source))).getText();
    } catch (error) {
      if (!(error instanceof Z.NotFoundException)) throw error;
      return undefined;
    }
  };
}

interface Box { x0: number; y0: number; x1: number; y1: number; kind: '1d' | '2d' }

/** Candidate barcode boxes in source-image pixels. */
export function locate(img: CanvasImageSource, W: number, H: number): Box[] {
  const s = Math.min(1, 800 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const bars = new Float32Array(w * h), tex = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = Math.abs(gray[i + 1] - gray[i - 1]), gy = Math.abs(gray[i + w] - gray[i - w]);
    bars[i] = Math.max(0, gx - gy);
    tex[i] = Math.min(gx, gy);
  }
  const boxes: Box[] = [];
  for (const [map, kind, bw, bh] of [[bars, '1d', 9, 3], [tex, '2d', 7, 7]] as const) {
    // box blur via integral image
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += map[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
    const blur = new Float32Array(w * h);
    let sum = 0, sum2 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - bw), xb = Math.min(w, x + bw + 1), ya = Math.max(0, y - bh), yb = Math.min(h, y + bh + 1);
      const v = (I[yb * (w + 1) + xb] - I[ya * (w + 1) + xb] - I[yb * (w + 1) + xa] + I[ya * (w + 1) + xa]) / ((xb - xa) * (yb - ya));
      blur[y * w + x] = v; sum += v; sum2 += v * v;
    }
    const mean = sum / (w * h), sd = Math.sqrt(Math.max(0, sum2 / (w * h) - mean * mean));
    const thr = mean + (kind === '1d' ? 1.5 : 2.5) * sd;
    const seen = new Uint8Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || blur[start] < thr) continue;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
      const stack = [start]; seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!; const x = i % w, y = (i - x) / w; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < w * h && !seen[j] && blur[j] >= thr) { seen[j] = 1; stack.push(j); }
      }
      const bwid = x1 - x0 + 1, bhgt = y1 - y0 + 1;
      if (n < 40) continue;
      if (kind === '1d' && !(bwid >= 20 && bwid >= bhgt * 1.3)) continue;
      if (kind === '2d' && !(bwid >= 18 && bhgt >= 18 && bwid / bhgt < 1.8 && bhgt / bwid < 1.8)) continue;
      boxes.push({ x0: x0 / s, y0: y0 / s, x1: (x1 + 1) / s, y1: (y1 + 1) / s, kind });
    }
  }
  // biggest first, cap the work
  return boxes.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0)).slice(0, 30);
}

export async function readBarcodes(img: HTMLImageElement, onProgress?: (p: number) => void): Promise<BarcodeHit[]> {
  const W = img.naturalWidth, H = img.naturalHeight;
  const hits: BarcodeHit[] = [];
  const add = (h: BarcodeHit) => { if (!hits.some((x) => x.text === h.text && Math.abs((x.y0 ?? 0) - (h.y0 ?? 0)) < 20)) hits.push(h); };

  // Native reader first where it exists (Android Chrome); it reports positions too.
  const BD = (window as any).BarcodeDetector;
  if (BD) {
    try {
      const fmts = (await BD.getSupportedFormats()).filter((f: string) => ['code_128', 'code_39', 'data_matrix', 'qr_code', 'pdf417'].includes(f));
      for (const b of await new BD({ formats: fmts }).detect(img)) {
        const r = b.boundingBox; add({ text: b.rawValue, format: b.format, x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
      }
    } catch { /* fall through to ZXing */ }
  }

  const Z = await loadZxing();
  const mk = (formats: any[]) => { const r = new Z.MultiFormatReader(); const hm = new Map(); hm.set(Z.DecodeHintType.POSSIBLE_FORMATS, formats); hm.set(Z.DecodeHintType.TRY_HARDER, true); r.setHints(hm); return r; };
  const r1d = mk([Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39]);
  const r2d = mk([Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.QR_CODE]);
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d', { willReadFrequently: true })!;

  const tryDecode = (reader: any, cx: number, cy: number, w: number, h: number, deg: number, scale: number, global: boolean): string | undefined => {
    cv.width = Math.max(8, Math.round(w * scale)); cv.height = Math.max(8, Math.round(h * scale));
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.translate(cv.width / 2, cv.height / 2); g.rotate((-deg * Math.PI) / 180); g.scale(scale, scale); g.translate(-cx, -cy);
    g.drawImage(img, 0, 0);
    try {
      const src = new Z.HTMLCanvasElementLuminanceSource(cv);
      return reader.decode(new Z.BinaryBitmap(global ? new Z.GlobalHistogramBinarizer(src) : new Z.HybridBinarizer(src))).getText();
    } catch { return undefined; }
  };

  const boxes = locate(img, W, H);
  const ANGLES = [0, -2, 2, -3.5, 3.5, -5, 5, -1, 1];
  for (let k = 0; k < boxes.length; k++) {
    onProgress?.(k / boxes.length);
    const b = boxes[k];
    if (hits.some((h) => h.y0 !== undefined && h.y0 >= b.y0 - 10 && h.y1! <= b.y1 + 10 && h.x0! >= b.x0 - 10 && h.x1! <= b.x1 + 10)) continue;
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    let text: string | undefined;
    if (b.kind === '1d') {
      const w = bw * 1.12 + 20, h = Math.max(bh * 1.8, 24);
      const scale = bw < 500 ? 2 : 1;
      outer: for (const deg of ANGLES) for (const glob of [false, true]) {
        text = tryDecode(r1d, cx, cy, w, h, deg, scale, glob);
        if (text) break outer;
      }
    } else {
      const side = Math.max(bw, bh) * 1.3 + 16;
      for (const deg of [0, -3, 3]) { text = tryDecode(r2d, cx, cy, side, side, deg, side < 300 ? 2 : 1, false); if (text) break; }
    }
    if (text) add({ text, format: b.kind === '1d' ? 'linear' : '2d', x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
  }
  onProgress?.(1);
  return hits;
}
