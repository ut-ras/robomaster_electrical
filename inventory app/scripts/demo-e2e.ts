// First-delivery walkthrough over real HTTP, as two separate signed-in "phones".
// Uses whatever the environment configures: live Mouser/DigiKey/Google Sheets if credentials are set,
// otherwise demo catalog data and an in-memory sheet. The report says which was used for every step.
//
//   npm run demo:e2e

import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.ts';
import { authFromEnv } from '../src/server/auth.ts';
import { providersFromEnv } from '../src/server/catalog/index.ts';
import { Inventory } from '../src/server/inventory.ts';
import { FileStore } from '../src/server/store/file-store.ts';
import { SheetsStore, loadServiceAccount } from '../src/server/store/sheets-store.ts';
import { MOUSER_74LVC244_OCR, DIGIKEY_TDK_OCR } from '../test/fixtures/labels.ts';

export async function runDemo(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = console.log) {
  const runEnv = { ...env, TEAM_MEMBERS: 'Phone One:1111,Phone Two:2222', SESSION_SECRET: 'demo-e2e' };
  const sa = loadServiceAccount(runEnv);
  const store = sa && runEnv.GOOGLE_SHEET_ID ? new SheetsStore(sa, runEnv.GOOGLE_SHEET_ID) : new FileStore();
  await store.ensureTabs();
  const providers = providersFromEnv(runEnv);
  const server = createApp({ inventory: new Inventory(store), providers, auth: authFromEnv(runEnv) });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const checks: { step: string; ok: boolean; data: string }[] = [];
  const check = (step: string, ok: boolean, data: string) => { checks.push({ step, ok, data }); log(`${ok ? 'PASS' : 'FAIL'}  ${step}  [${data}]`); };

  async function phone(name: string, pin: string) {
    const { token } = await (await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name, pin }) })).json();
    return async (path: string, body?: unknown) => {
      const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json();
      if (!r.ok) throw new Error(`${path}: ${j.error}`);
      return j;
    };
  }

  try {
    const storeLabel = store.mode === 'sheets' ? 'live Google Sheet' : 'in-memory demo sheet';
    log(`Mouser: ${providers.mouser.mode} | DigiKey: ${providers.digikey.mode} | storage: ${storeLabel}\n`);
    const unauth = await fetch(`${base}/api/search?q=x`);
    check('writes/reads refused without team sign-in', unauth.status === 401, `HTTP ${unauth.status}`);

    const a = await phone('Phone One', '1111');
    const b = await phone('Phone Two', '2222');

    async function scanAndSave(ocr: string, drawer: string, expect: { sku: string; mpn: string; qty: string }) {
      const fields = await a('/api/parse', { text: ocr, barcodes: [] });
      const parsedOk = fields.sku?.value === expect.sku && fields.mpn?.value === expect.mpn && fields.quantity?.value === expect.qty;
      check(`scan ${expect.sku}: label fields`, parsedOk, `${fields.supplier?.value} ${fields.sku?.value} / ${fields.mpn?.value} / qty ${fields.quantity?.value} / ${fields.manufacturer?.value}`);
      const id = await a('/api/identify', { supplier: fields.supplier.value, sku: fields.sku.value, mpn: fields.mpn.value, manufacturer: fields.manufacturer?.value });
      check(`identify ${expect.sku} (${id.catalogMode.primary} catalog)`, id.status === 'matched' && id.chosen.mpn === expect.mpn, `${id.status}: ${id.chosen?.manufacturer} ${id.chosen?.mpn}; ${id.chosen?.summary.map((s: any) => `${s.label}=${s.value}`).join(', ')}`);
      const requestId = `save-${expect.sku}`;
      const saved = await a('/api/parts', { requestId, drawer, part: id.chosen, crossSku: id.crossSku });
      const again = await a('/api/parts', { requestId, drawer, part: id.chosen, crossSku: id.crossSku });
      check(`save ${expect.sku} to ${drawer} (retry safe)`, saved.partId === again.partId && again.created === false, saved.partId);
      return saved.partId as string;
    }

    const mouserId = await scanAndSave(MOUSER_74LVC244_OCR, 'A1', { sku: '771-74LVC244APW-T', mpn: '74LVC244APW,118', qty: '12' });
    const dkId = await scanAndSave(DIGIKEY_TDK_OCR, 'C4', { sku: '495-75588-ND', mpn: 'B32529C0564J000', qty: '10' });

    for (const [q, id, drawer] of [['771-74LVC244APW-T', mouserId, 'A1'], ['74LVC244APW,118', mouserId, 'A1'], ['495-75588-ND', dkId, 'C4'], ['B32529C0564J000', dkId, 'C4']] as const) {
      const r = await b(`/api/search?q=${encodeURIComponent(q)}`);
      const hit = r.hits[0]?.part;
      check(`second phone finds "${q}"`, r.hits.length === 1 && hit.partId === id && hit.locations.some((l: any) => l.drawer === drawer), hit ? `${hit.mpn} @ ${hit.locations.map((l: any) => l.drawer).join(',')}` : 'no hit');
    }
    const p = await b(`/api/parts/${mouserId}`);
    check('scanning and saving did not change stock', p.history.length === 0 && p.locations.every((l: any) => l.qty === null), `ledger rows: ${p.history.length}`);

    // Manual part-number entry for capacitors, then the parametric search.
    const capIds: Record<string, string> = {};
    for (const [sku, drawer] of [['80-C0805C104J5R', 'E2'], ['81-GRM188R71C104KA01', 'E3'], ['81-GRM188F51H104ZA01', 'E3']] as const) {
      const id = await b('/api/identify', { supplier: 'mouser', sku });
      if (id.status !== 'matched') { check(`manual entry ${sku}`, false, id.reasons.join('; ')); continue; }
      const s = await b('/api/parts', { requestId: `cap-${sku}`, drawer, part: id.chosen });
      capIds[sku] = s.partId;
      check(`manual entry ${sku} -> ${drawer} (${id.catalogMode.primary} catalog)`, true, id.chosen.summary.filter((x: any) => x.known).map((x: any) => `${x.label}=${x.value}`).join(', '));
    }
    const q = '100 nF capacitor, at least 25 V, ±10% or tighter';
    const r = await a(`/api/search?q=${encodeURIComponent(q)}`);
    const found = r.hits.map((h: any) => h.part.mpn);
    check(`search "${q}"`, found.length === 1 && found[0] === 'C0805C104J5RACTU', `${found.join(', ') || 'none'} (16 V and -20%/+80% parts excluded)`);
    const r2 = await a(`/api/search?q=${encodeURIComponent('0.1uF cap >=25V 10%')}`);
    check('0.1 µF form gives the same result', JSON.stringify(r2.hits.map((h: any) => h.part.mpn)) === JSON.stringify(found), r2.hits.map((h: any) => h.part.mpn).join(', '));

    // Stock, last: receive a counted quantity, then two phones remove at the same time.
    const capId = capIds['80-C0805C104J5R'];
    await a('/api/stock', { requestId: 'rx-1', partId: capId, drawer: 'E2', delta: 4, reason: 'receive', note: 'printed qty 10, counted 4' });
    const dup = await a('/api/stock', { requestId: 'rx-1', partId: capId, drawer: 'E2', delta: 4, reason: 'receive' });
    check('duplicate receive ignored', dup.duplicate === true && dup.balance === 4, `balance ${dup.balance}`);
    const both = await Promise.allSettled([
      a('/api/stock', { requestId: 'rm-a', partId: capId, drawer: 'E2', delta: -3 }),
      b('/api/stock', { requestId: 'rm-b', partId: capId, drawer: 'E2', delta: -3 }),
    ]);
    check('concurrent removals: one succeeds, one refused', both.filter((x) => x.status === 'fulfilled').length === 1, both.map((x) => (x.status === 'fulfilled' ? `ok balance ${x.value.balance}` : (x.reason as Error).message)).join(' | '));
    const hist = (await b(`/api/parts/${capId}`)).history;
    check('ledger records member, time, drawer, quantity', hist.length === 2 && hist.every((h: any) => h.member && h.timestamp && h.drawer && h.delta), hist.map((h: any) => `${h.member} ${h.delta} @${h.drawer}`).join('; '));
  } finally {
    server.close();
  }
  const failed = checks.filter((c) => !c.ok).length;
  log(`\n${checks.length - failed}/${checks.length} checks passed`);
  return { checks, failed, modes: { mouser: providers.mouser.mode, digikey: providers.digikey.mode, store: store.mode } };
}

if (import.meta.main) {
  const { failed } = await runDemo();
  process.exit(failed ? 1 : 0);
}
