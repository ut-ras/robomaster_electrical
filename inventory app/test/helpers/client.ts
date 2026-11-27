// Minimal DOM for exercising the real client event handlers against an isolated HTTP demo.
// Physical camera behavior and browser layout still need browser/phone checks.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createReceipt } from '../../src/client/receiving.ts';
import { parseLiveProductBarcode } from '../../src/shared/labels.ts';
import * as hardware from '../../src/shared/hardware.ts';

class Element {
  tagName: string;
  children: (Element | string)[] = [];
  parent: Element | undefined;
  attrs: Record<string, string> = {};
  events: Record<string, ((e: any) => any)[]> = {};
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  value = ''; disabled = false; hidden = false; open = false;
  _text = ''; onclick?: (e: any) => any;
  classList = { toggle() {} };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  append(...children: (Element | string)[]) { for (const child of children) { if (typeof child !== 'string') child.parent = this; this.children.push(child); } }
  prepend(...children: (Element | string)[]) { const old = [...this.children]; this.children = []; this.append(...children, ...old); }
  replaceChildren(...children: (Element | string)[]) { for (const c of this.children) if (typeof c !== 'string') c.parent = undefined; this.children = []; this._text = ''; this.append(...children); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === 'open') this.open = true; }
  addEventListener(key: string, fn: (e: any) => any) { (this.events[key] ??= []).push(fn); }
  async dispatchEvent(e: any) { e.target = this; for (const fn of this.events[e.type] ?? []) await fn(e); }
  async click() {
    for (let p: Element | undefined = this; p; p = p.parent) if (p.disabled) return;
    await this.onclick?.({ target: this }); await this.dispatchEvent({ type: 'click' });
  }
  get textContent(): string { return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(text: string) { this.replaceChildren(); this._text = text; }
  get isConnected(): boolean { return this.attrs.id === 'view' || !!this.parent?.isConnected; }
  querySelectorAll(selector: string): Element[] {
    const all = this.children.flatMap(c => typeof c === 'string' ? [] : [c, ...c.querySelectorAll('*')]);
    if (selector === '*') return all;
    if (selector === '[data-spec]') return all.filter(c => c.attrs['data-spec']);
    return all.filter(c => c.tagName.toLowerCase() === selector);
  }
  focus() {} scrollIntoView() {}
}

export async function client(demo: { base: string; token: string }, intercept?: (path: string, body: any) => Promise<Response | undefined>) {
  const roots = Object.fromEntries(['view', 'tabs', 'signout', 'modes', 'sheetlink'].map(id => { const el = new Element('div'); el.attrs.id = id; return [id, el]; }));
  const requests: { path: string; body: any }[] = [];
  const pending = new Set<Promise<Response>>();
  const context: any = { console, ...hardware, createReceipt, parseLiveProductBarcode, structuredClone, crypto: { randomUUID },
    HTMLInputElement: Element, HTMLTextAreaElement: Element, HTMLSelectElement: Element,
    localStorage: { getItem: (key: string) => key === 'token' ? demo.token : 'Demo One' },
    document: { createElement: (tag: string) => new Element(tag), getElementById: (id: string) => roots[id], querySelectorAll: () => [] },
    navigator: {}, window: { addEventListener() {}, scrollTo() {}, setTimeout, clearTimeout }, clearTimeout,
    fetch: (path: string, options: any = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body });
      const task = (async () => await intercept?.(path, body) ?? await fetch(demo.base + path, options))();
      pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task)); return task;
    },
  };
  const source = stripTypeScriptTypes(await readFile(new URL('../../src/client/app.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/showSheetLink\(\);\r?\nif \(token\) start\(\); else renderLogin\(\);\s*$/, '');
  vm.createContext(context);
  vm.runInContext(source + '\nglobalThis.ui = { renderReview, renderScan, renderSearch, renderHardware };', context);
  const all = () => roots.view.querySelectorAll('*');
  const find = (predicate: (el: Element) => boolean) => { const el = all().find(predicate); if (!el) throw new Error('Client control not found'); return el; };
  return { ...context.ui, requests, view: roots.view,
    button: (text: string) => find(el => el.tagName === 'BUTTON' && el.textContent === text),
    input: (label: string) => find(el => el.attrs['aria-label'] === label),
    all,
    async idle() { while (pending.size) await Promise.allSettled([...pending]); await new Promise(ok => setImmediate(ok)); },
  };
}
