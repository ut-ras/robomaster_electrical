import type { CatalogPart } from '../shared/types.ts';
import { normDrawer } from '../shared/hardware.ts';

export interface ReceiptDraft {
  count: string;
  drawer: string;
  note: string;
  part: CatalogPart;
  crossSku?: { supplier: string; sku: string };
  manualSpecs?: { name: string; value: string; sourceRef: string }[];
}

export interface ReceiptResult {
  partId: string;
  drawer: string;
  count?: number;
  balance?: number;
  duplicate?: boolean;
}

/** One bag, one immutable operation. A lost response must retry the original payload and ids. */
export function createReceipt(post: (path: string, body: unknown) => Promise<any>, saveId: string, stockId: string, existingId?: string) {
  let partId = existingId;
  let intent: { draft: ReceiptDraft; count?: number; addStock: boolean } | undefined;
  let running: Promise<ReceiptResult> | undefined;
  let done: ReceiptResult | undefined;

  return {
    get started() { return !!intent; },
    get partId() { return partId; },
    submit(draft: ReceiptDraft, addStock: boolean): Promise<ReceiptResult> {
      if (done) return Promise.resolve(done);
      if (running) return running;
      if (!intent) {
        const count = Number(draft.count);
        if (addStock && (!/^\d+$/.test(draft.count.trim()) || !Number.isSafeInteger(count) || count <= 0)) {
          throw new Error('Enter the counted quantity as a positive whole number.');
        }
        if (!draft.part.manufacturer.trim() || !draft.part.mpn.trim()) throw new Error('Manufacturer and manufacturer part number are required');
        if (draft.manualSpecs?.some((s) => !s.sourceRef.trim())) throw new Error('Every manual spec needs a datasheet page or source link');
        intent = { draft: structuredClone({ ...draft, drawer: normDrawer(draft.drawer), note: draft.note.trim() }), count: addStock ? count : undefined, addStock };
      }
      const attempt = async (): Promise<ReceiptResult> => {
        const { draft, count, addStock } = intent!;
        if (!partId) {
          const saved = await post('/api/parts', { requestId: saveId, drawer: draft.drawer, part: draft.part, crossSku: draft.crossSku, manualSpecs: draft.manualSpecs });
          partId = saved.partId;
        }
        const stock = addStock ? await post('/api/stock', { requestId: stockId, partId, drawer: draft.drawer, delta: count, reason: 'receive', note: draft.note }) : undefined;
        done = { partId: partId!, drawer: draft.drawer, count, balance: stock?.balance, duplicate: stock?.duplicate };
        return done;
      };
      running = attempt().finally(() => { running = undefined; });
      return running;
    },
  };
}
