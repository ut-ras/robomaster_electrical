# Handoff

Robotics team parts inventory: a mobile web app for iPhone and Android. Photograph a Mouser or
DigiKey bag, check what it read, look the part up in the supplier's catalog, and save it to a
drawer in one shared Google Sheet. Teammates search by SKU, part number, description, specs or
drawer from any phone.

`README.md` is the full reference. This file is the short version for whoever picks the project up:
how to run it, what is finished, how the Mouser barcode fix works, and what is still unverified.

---

## 1. Running it

You need **Node 22.18 or newer** (24 recommended). There are **no npm dependencies** — Node runs the
`.ts` files directly, and the server strips types from the browser code as it serves it. There is no
build step and no `npm install`.

```powershell
copy .env.example .env
```

```powershell
npm start
```

```powershell
npm test
```

With an empty `.env` the app runs fully in **demo mode**: demo catalog records, local JSON storage in
`data/demo-sheet.json`, and sign-ins `Demo One` / `1111` and `Demo Two` / `2222`. The header on every
screen says whether Mouser, DigiKey and storage are live or demo.

The server prints a `http://<laptop-ip>:8787` address. Phones on the same Wi-Fi open that. The camera
works over plain HTTP because it goes through the photo picker, not `getUserMedia`. To use it away
from that Wi-Fi, host it somewhere with HTTPS (Render, Fly.io, Railway, or a Raspberry Pi with
Caddy). Run **one instance per Sheet** — write serialization is an in-process lock.

Credentials for live mode (team PINs, Google service account, Mouser key, DigiKey client
ID/secret) are all server-side and documented in the table in `README.md`. Phones only ever receive a
signed team token.

### Not in this ZIP

- `.env` — copy `.env.example` instead.
- Service-account keys / any credential file. None were ever committed; `.gitignore` covers
  `.env`, `secrets/`, `*.json.key` and `data/`.
- `test/photos/` — the two original bag photos. They show purchase-order and invoice numbers, so
  they are excluded. The regression test does not need them (see §3), but the manual photo check in
  `README.md` does: drop your own bag photos in `test/photos/` and set `SERVE_TEST_PHOTOS=1` in
  `.env` if you want the server to serve them for testing. **Keep that setting local.**
- `.claude/launch.json` — a dev-server config pointing at an absolute `node.exe` path on the machine
  this was built on. Use `npm start`.

---

## 2. What is implemented

Everything in the brief, in the order it was asked for.

| Area | State |
|---|---|
| Scan: camera, upload, or typed part number | Done |
| Supplier detection + manual override | Done |
| OCR of SKU, MPN, manufacturer, description, quantity | Done, with trust checks (§3) |
| Barcode reading, including field assignment | Done (§3) |
| Catalog lookup (Mouser Search, DigiKey ProductDetails v4) | Written to the published API docs, **not yet run live** |
| Cross-check against the label, choices on conflict | Done |
| Gap-fill from the other catalog on exact manufacturer + MPN | Done |
| Full spec storage (name, value, unit, min/max, tolerance, condition, source, link, verified) | Done |
| Asymmetric and absolute tolerances (`-20/+80%`, `±0.1 pF`) | Done |
| Category summaries, "All specs", *unknown* for missing | Done |
| Manual specs with a required source; verified rows survive a refresh | Done |
| Google Sheet: `Parts`, `Supplier SKUs`, `Specs`, `Locations`, `Stock Ledger` | Written, **not yet run against Google** |
| One record per manufacturer + MPN; part numbers written as text | Done |
| Idempotent saves (upserts); SKU already linked elsewhere is refused | Done |
| Search by SKU/MPN/description/category/spec/drawer | Done |
| Parametric queries (`100 nF capacitor, at least 25 V, ±10% or tighter`) | Done |
| Stock ledger: member, time, drawer, signed quantity, request id | Done |
| Duplicate request ids return the first result; removals cannot go negative | Done |
| Scanning never changes stock | Done — after a save the app *suggests* the printed quantity; a member must confirm the real count |

### Layout

```
src/shared/   label parsing, unit/tolerance parsing, spec mapping, search  (server + phone)
src/server/   HTTP API, team sign-in, Mouser + DigiKey clients, Sheets store, inventory rules
src/client/   phone UI: camera/upload, OCR, barcode reading, review, search, stock
public/       index.html, styles.css
test/         unit + end-to-end tests        scripts/  demo-e2e.ts, init-sheet.ts
```

---

## 3. The Mouser barcode fix

**The bug.** Scanning the real Mouser bag read the supplier and quantity 12 but left both part-number
fields blank. Tesseract garbles both part-number lines on that photo, differently on each run:

```
Mouser P/N: 971 04) yeoaanpy          MFG P/N: 741YC2q4ppPu, 118
Mouser py: 771-241 YLR44APY-T         MFG P/N: 74 ycaqanpy, 118
```

No barcode was read at all: the app used only the browser's built-in `BarcodeDetector`, which iPhone
Safari and desktop Chromium do not have.

**The fix** is three parts.

**1. A barcode reader that works everywhere** — `src/client/barcodes.ts`. It uses the native
`BarcodeDetector` when present (Android Chrome), and otherwise ZXing from a pinned CDN URL. The two
long part-number barcodes only decode when cropped tightly and rotated a degree or two to match how
the bag was lying, so the reader first finds barcode-shaped regions with a gradient map, then decodes
each region at several small angles, upscaling narrow ones. Every hit keeps its box in the photo.

**2. A barcode only fills a field when it can be proven to belong there** —
`assignMouser` / `assignDigikey` in `src/shared/labels.ts`. The accepted proofs are:

- the barcode sits directly under that field's printed caption (`Mouser P/N`, `MFG P/N`, `QTY`),
  matched by comparing the caption line's centre with the barcode's;
- its content proves it: a Mouser-format SKU with the `MFG P/N` barcode just below sharing the same
  part stem;
- it agrees with what OCR read for that field (fuzzy, with `O/0`, `I/1`, `S/5`, `B/8` treated as
  equal);
- it is an ECIA / ISO-15434 2D code, which names its own fields (`P`, `1P`, `Q`).

A barcode that cannot be tied to a field is **listed with one-tap "SKU / MPN / Qty" buttons**, never
guessed into a field. Two barcodes that both qualify for the same field means neither is used.

**3. OCR is no longer trusted on its own.** An OCR part number fills a field only if it passes the
supplier's format check *and* its stem agrees with the other identifier. Otherwise it appears as an
untrusted hint with a "Use it anyway" button. If neither identifier is reliable, the review screen
shows **"Couldn't read the part number"** with **Retake close-up** and **Enter SKU manually** (which
puts the cursor in the SKU field). The raw OCR text and every decoded barcode are always visible
under "Raw OCR text and barcodes".

**Verified** by uploading the original photo through the app's own Upload button, in Chromium at
375 px and 768 px (no native `BarcodeDetector`, so the same path iPhone Safari takes). Stable across
repeated runs at both widths:

| Field | Value | Where it came from |
|---|---|---|
| SKU | `771-74LVC244APW-T` | barcode under "Mouser P/N" |
| MPN | `74LVC244APW,118` | barcode under "MFG P/N" — comma preserved |
| Quantity | `12` | barcode |
| Manufacturer | `Nexperia` | text |
| Supplier | Mouser | text |

"Look up in catalog" then gave an exact match. A scan takes about 3–5 s on a laptop; expect longer on
an older phone.

**Regression test:** `test/photo-scan.test.ts` replays the OCR text, OCR line boxes and barcode
positions recorded from that photo (`test/fixtures/mouser-photo.ts`), so it runs without the photo
itself. 33 tests pass, no network needed.

---

## 4. The DigiKey scan still needs testing

The DigiKey bag photo available during the build was only **387×516 px** — a screen-sized image, not
a phone camera photo. At that size neither the printed part number nor the 2D code is legible, even
upscaled. Scanning it correctly shows **"Couldn't read the part number"**; typing `495-75588-ND`
after that matches TDK `B32529C0564J000`.

So **the DigiKey path has never been exercised with a real, full-resolution photo.** The first thing
to do with this project:

1. Take a close-up photo of a DigiKey bag with a phone and scan it.
2. Check whether its **DataMatrix code decodes.** If it does, `parseEcia` in `src/shared/labels.ts`
   already reads the self-describing `P` (SKU), `1P` (MPN) and `Q` (quantity) fields and is trusted
   ahead of everything else — but that branch has only been tested against a transcription, never
   against a code decoded from a real photo.
3. If it does not decode, check the 1D `-ND` barcode and whether its caption is found. `assignDigikey`
   is thinner than `assignMouser`: it accepts a single uniquely `-ND`-formatted barcode, and verifies
   the MPN and quantity by OCR agreement only. It likely needs the same caption-position rule the
   Mouser path has.

Also untested on the Mouser side: the Mouser **DataMatrix** never decoded from the sample photo, and
neither did the PO barcode (it has a smudge across it). Neither is needed, since the 1D barcodes
carry everything.

---

## 5. Verified in demo mode only

No Mouser, DigiKey or Google credentials were available while this was built. Everything below is
demo data. `npm run demo:e2e` repeats the whole walkthrough and reports live or demo per step; fill
in `.env` first to run it live.

| Check | Status | Live or demo |
|---|---|---|
| Mouser bag, original photo, real scan flow | Passes — see §3 | **Real photo** |
| DigiKey bag, 387×516 px photo | Shows "Couldn't read the part number" — see §4 | **Real photo**, too small |
| DigiKey row: `WM20054-ND` / Molex / `0387236506` / qty 2 | Passes; leading zero kept through parse, save and search | Demo record, specs *unknown* |
| Catalog lookup and specs for all of the above | Passes | **Demo** records in `src/server/catalog/fixtures.ts`, shaped like the real API responses |
| Save both bags to different drawers, find them from a second session | Passes | Local demo JSON, **not Google Sheets** |
| Manual capacitor entry, then `25 V` / `±10%` search | Passes: 50 V ±5% qualifies; 16 V, ±20%, −20/+80% and unknown tolerance are excluded | Demo records. The Murata/KEMET Mouser SKUs were typed from memory — **check them live** |
| Phone UI: sign-in, manual entry, save, search | Checked in a 375 px browser | Demo |
| Google Sheets, Mouser and DigiKey clients | Written to the published APIs, **never run against them** | Needs credentials |

**What that means for the first live run.** DigiKey v4 `productdetails` and Mouser Search request and
response shapes come from the public docs only. The normalizers in `src/server/catalog/mouser.ts` and
`digikey.ts` are the first thing to check if a live lookup returns nothing. Same for the Sheets
writes: `npm run sheets:init` creates the tabs and is the quickest way to confirm the service account
really has Editor access.

**Real phones have not been tested at all.** Chromium at phone widths takes the same no-native-reader
path as iPhone Safari, which is why the result above is meaningful, but Android Chrome's native
`BarcodeDetector` branch and real phone speed are both unverified.

---

## 6. Known limits

- **One server instance per Sheet.** Concurrency safety is an in-process lock; two servers writing to
  one Sheet can race the stock checks.
- Every search reads all tabs. Fine for a few thousand rows; add caching beyond that.
- OCR + barcode reading is 3–5 s per photo on a laptop.
- tesseract.js and ZXing load from pinned CDN URLs, so the first scan on a phone needs internet even
  in demo mode.
- In the Mouser demo record the 74LVC244's pin count is *unknown*, because Mouser does not list it. A
  live DigiKey lookup with an exact MPN match fills it in.
