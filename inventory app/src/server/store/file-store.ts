// Local stand-in for the Google Sheet: same tabs and columns, persisted as JSON. Used in demo mode and tests.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TABS, fromCells, toCells, type Row, type TabId, type TableStore } from './tables.ts';

type Data = Record<string, string[][]>; // tab name -> rows including header

export class FileStore implements TableStore {
  readonly mode = 'file' as const;
  path: string | undefined;
  data: Data = {};

  /** path undefined = in-memory only (tests). */
  constructor(path?: string) {
    this.path = path;
    if (path && existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8')) as Data;
  }

  private flush() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.path);
  }

  async ensureTabs() {
    for (const t of Object.values(TABS)) if (!this.data[t.name]) this.data[t.name] = [[...t.header]];
    this.flush();
  }

  async read(tab: TabId): Promise<Row[]> {
    const rows = this.data[TABS[tab].name] ?? [];
    return rows.slice(1).map((r) => fromCells(tab, r));
  }

  async append(tab: TabId, rows: Row[]) {
    const t = (this.data[TABS[tab].name] ??= [[...TABS[tab].header]]);
    for (const r of rows) t.push(toCells(tab, r));
    this.flush();
  }

  async update(tab: TabId, index: number, row: Row) {
    const t = this.data[TABS[tab].name];
    if (!t || !t[index + 1]) throw new Error(`row ${index} missing in ${tab}`);
    t[index + 1] = toCells(tab, row);
    this.flush();
  }

  async deleteByPartId(partId: string) {
    if (!partId) throw new Error('partId required');
    const previous = this.data;
    const next = { ...previous };
    for (const tab of Object.values(TABS)) {
      const column = tab.header.indexOf('part_id');
      if (previous[tab.name]) next[tab.name] = previous[tab.name].filter((cells, i) => i === 0 || cells[column] !== partId);
    }
    this.data = next;
    try { this.flush(); } catch (error) { this.data = previous; throw error; }
  }
}
