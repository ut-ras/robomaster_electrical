// Google Sheets API v4 backend using a service account (no client libraries; JWT is signed with node:crypto).
// Every write uses valueInputOption=RAW so Sheets never re-interprets text: "0387236506" keeps its leading zero
// and "74LVC244APW,118" is never split or turned into a number. Columns are also formatted as plain text.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TABS, fromCells, toCells, type Row, type TabId, type TableStore } from './tables.ts';

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

export function loadServiceAccount(env: NodeJS.ProcessEnv = process.env): ServiceAccount | undefined {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text) as ServiceAccount;
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_FILE) return JSON.parse(readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8')) as ServiceAccount;
  return undefined;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function colLetter(n: number): string {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export class SheetsStore implements TableStore {
  readonly mode = 'sheets' as const;
  sa: ServiceAccount;
  spreadsheetId: string;
  private token?: { value: string; expires: number };

  constructor(sa: ServiceAccount, spreadsheetId: string) {
    this.sa = sa;
    this.spreadsheetId = spreadsheetId;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: this.sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: this.sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const jwt = `${header}.${claims}.${b64url(signer.sign(this.sa.private_key))}`;
    const res = await fetch(this.sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    if (!res.ok) throw new Error(`Google OAuth HTTP ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return this.token.value;
  }

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Sheets API ${init.method ?? 'GET'} ${path.split('?')[0]} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  private range(tab: TabId, a1: string) { return encodeURIComponent(`'${TABS[tab].name}'!${a1}`); }

  async ensureTabs() {
    const meta = await this.api('?fields=sheets.properties');
    const existing = new Map<string, number>((meta.sheets ?? []).map((s: any) => [s.properties.title, s.properties.sheetId]));
    const missing = Object.values(TABS).filter((t) => !existing.has(t.name));
    if (missing.length) {
      const r = await this.api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: missing.map((t) => ({ addSheet: { properties: { title: t.name, gridProperties: { frozenRowCount: 1 } } } })) }) });
      for (const rep of r.replies ?? []) existing.set(rep.addSheet.properties.title, rep.addSheet.properties.sheetId);
    }
    const requests: unknown[] = [];
    for (const [id, t] of Object.entries(TABS) as [TabId, (typeof TABS)[TabId]][]) {
      await this.api(`/values/${this.range(id, `A1:${colLetter(t.header.length - 1)}1`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [t.header] }) });
      // Plain-text format so manual edits in the Sheet UI also keep leading zeros and commas.
      requests.push({ repeatCell: { range: { sheetId: existing.get(t.name), startColumnIndex: 0, endColumnIndex: t.header.length }, cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat.numberFormat' } });
    }
    await this.api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  }

  async read(tab: TabId): Promise<Row[]> {
    const t = TABS[tab];
    const r = await this.api(`/values/${this.range(tab, `A2:${colLetter(t.header.length - 1)}`)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
    return ((r.values ?? []) as unknown[][]).map((cells) => fromCells(tab, cells));
  }

  async append(tab: TabId, rows: Row[]) {
    if (!rows.length) return;
    const t = TABS[tab];
    await this.api(`/values/${this.range(tab, `A1:${colLetter(t.header.length - 1)}1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST', body: JSON.stringify({ values: rows.map((r) => toCells(tab, r)) }),
    });
  }

  async update(tab: TabId, index: number, row: Row) {
    const t = TABS[tab];
    const n = index + 2;
    await this.api(`/values/${this.range(tab, `A${n}:${colLetter(t.header.length - 1)}${n}`)}?valueInputOption=RAW`, {
      method: 'PUT', body: JSON.stringify({ values: [toCells(tab, row)] }),
    });
  }
}
