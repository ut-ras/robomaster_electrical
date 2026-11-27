# Robotics team parts inventory

This is a mobile web app for iPhone and Android. Scan a Mouser or DigiKey bag, review the matched part, and confirm the actual count to receive it into inventory. Teammates can search by SKU, part number, specs or drawer from any phone.

It is a single TypeScript project with **no npm dependencies**. Node ≥ 22.18 runs the `.ts` files directly. The server also strips types from the browser code as it serves it, so there is no build step.

```
src/shared/   label parsing, unit/tolerance parsing, spec mapping, search (used by server and phone)
src/server/   HTTP API, team sign-in, Mouser + DigiKey clients, Google Sheets store, inventory rules
src/client/   phone UI (camera/upload, OCR, review, search, stock)
public/       index.html, styles.css
test/         unit + end-to-end tests      scripts/  demo-e2e.ts, init-sheet.ts
```

## Run it

For an isolated local demo that **ignores `.env` and all service credentials**, run from `inventory app`:

```powershell
npm run start:demo
```

Open [localhost:8787](http://localhost:8787) and sign in as **Demo One / 1111** or **Demo Two / 2222**. This mode uses bundled catalog fixtures and memory-only inventory, with no Google Sheet or inventory file access. Data resets when the server stops. Try **Enter part number**, select Mouser, and look up `771-74LVC244APW-T`; DigiKey examples are `495-75588-ND` and `WM20054-ND`. Receive one bag, then enter the same SKU again to try the existing-part **Add stock** flow. Leave the drawer blank to try **Not specified**, or use **Save part only** to leave stock unchanged.

For configured storage and catalogs:

```powershell
copy .env.example .env      # fill in what you have; empty blocks run in demo mode
npm start                   # or: node --env-file-if-exists=.env src/server/main.ts
npm test                    # isolated demo/unit tests, no live services
npm run demo:e2e            # first-delivery walkthrough, uses live services if configured
```

The configured server prints a `http://<laptop-ip>:8787` address. Phones on the same Wi-Fi can open it for photo upload and manual entry. **Live barcode scanning requires HTTPS on phones**, or `localhost` on the computer running the server. The isolated demo binds only to this computer. Run **one** instance per Sheet, because writes are serialized inside that process.

With nothing configured, the app runs in demo mode:
- Catalog data comes from the demo records in `src/server/catalog/fixtures.ts`.
- Data is stored in `data/demo-sheet.json`, which has the same tabs and columns as the Sheet.
- Sign-ins are `Demo One`/1111 and `Demo Two`/2222.

The header on every screen says whether Mouser, DigiKey and storage are live or demo.

## Receiving a bag

- **Scan barcode** is the main action; **Take photo**, **Upload photo**, **Enter part number**, and **Add hardware** remain available. A confident barcode or photo read starts catalog lookup automatically. Manual entry reaches the same review after lookup. Unclear matches require choosing the exact candidate or correcting the identifiers.
- The review shows the matched part, counted quantity, optional drawer, and optional stock note. A printed quantity is only a suggestion: the count starts blank and stock is added only after a positive whole count is supplied and confirmed. A blank drawer means **Not specified**.
- An exact existing manufacturer + MPN match shows its current drawers and counts and offers **Add stock**, without saving the part again. New parts offer **Save and add stock** and **Save part only**.
- Confirmation stays visible until you move on. **Scan next** starts the next barcode scan; **Other entry options** opens the photo/manual/hardware choices.
- If the part saves but stock cannot be confirmed, the review says so and keeps the count, drawer, and note visible. **Retry add stock** reuses the original stock request and payload, including when the first response was lost. Inputs lock after submission so a retry cannot silently change the intended operation. Each new bag gets a fresh operation.

## Credentials (all server-side)

| What | Where to get it | `.env` keys |
|---|---|---|
| Team sign-in | You choose. One `Name:PIN` per member. Remove a name to revoke access. | `TEAM_MEMBERS`, `SESSION_SECRET` |
| Google Sheet | 1. Create a blank Sheet. 2. In Google Cloud, create a project, enable the **Google Sheets API**, create a **service account**, and download its JSON key into `secrets/`. 3. Share the Sheet with the service account's `client_email` as **Editor**. 4. Run `npm run sheets:init` to create the tabs. | `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_FILE` (or `_JSON`) |
| Mouser | mouser.com, then My Account, then APIs, then **Search API** key | `MOUSER_API_KEY` |
| DigiKey | developer.digikey.com: create an organization and a **Production** app with the *Product Information v4* API. Use the client ID and secret (client-credentials flow). | `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` |

Phones only ever receive a signed team token. Every API call except `/api/status` and `/api/login` requires that token, so non-members can neither read nor write.

## How the requirements map to the code

**Scanning** (`src/client/app.ts`, `src/client/barcodes.ts`, `src/shared/labels.ts`)
- **Scan barcode** opens a live rear-camera preview for Mouser and DigiKey. Center a product barcode and verify the result on the review screen. Use the hosted HTTPS link on phones, or `localhost` when testing on the same computer as the server. Use **Take photo** or manual entry if the live camera or a product barcode is unavailable.
- Members can take a photo, upload one, or type a part number.
- OCR (tesseract.js) and a barcode reader (ZXing, compiled to JavaScript) run on the phone. Both load from pinned CDN URLs. This works the same on iPhone and Android; Android Chrome's built-in barcode reader is also used when present.
- The barcode reader first finds barcode-shaped regions, then decodes each one at several small angles, because bags are rarely photographed square. Every barcode keeps its position in the photo.
- **A barcode fills a field only when it can be proven to belong there:**
  - it sits directly under that field's printed caption ("Mouser P/N", "MFG P/N", "QTY"), or
  - its content proves it: a Mouser SKU format, with the MFG P/N barcode just below sharing the same part stem, or
  - it matches what OCR read for that field, or
  - it is an ECIA 2D code, which names its own fields (`P`, `1P`, `Q`).

  Barcodes that can't be tied to a field are listed with one-tap "SKU / MPN / Qty" buttons instead of being guessed.
- OCR part numbers fill a field only if they pass format checks and agree with the other identifier. Otherwise they are shown as an untrusted hint with "Use it anyway".
- If neither the SKU nor the MPN is reliable, the review screen says **"Couldn't read the part number"** and offers **Retake close-up** or **Enter SKU manually**.
- The supplier is detected from the label text and can be changed in a dropdown. Each field shows where its value came from, and the raw OCR text and decoded barcodes are under "Raw OCR text and barcodes".
- The photo stays pinned at the top of the review screen. Tap it to zoom.

**Identification** (`src/server/catalog/`)
- The bag's own catalog is searched by SKU: Mouser `search/partnumber` (Exact), or DigiKey v4 `productdetails`.
- The result's manufacturer and full MPN are compared with the label. Names are normalized, so "EPCOS - TDK Electronics" matches "TDK ELECTRONICS INC".
- A mismatch, or more than one variant, shows a list of choices to review.
- If summary specs or the datasheet link are missing, the *other* catalog is asked. Its data is used only when its record has the exact same manufacturer and MPN.

**Specs**
- Every attribute is stored with its original name and value, plus:
  - parsed number, unit, min/max
  - tolerance (percent or absolute, asymmetric sides kept)
  - test condition
  - source, source link and verified flag
- Each category gets a short summary, and missing values show as *unknown*. "All specs" expands the full list.
- Manual specs require a datasheet page or link and are marked verified. A catalog refresh never overwrites a verified row.

**Sheet** (`src/server/store/`, `src/server/inventory.ts`)
- Tabs: `Parts`, `Supplier SKUs`, `Specs`, `Locations`, plus `Stock Ledger`.
- `part_id` is a hash of manufacturer + exact MPN, so the same component bought from both suppliers gets one record. Parts that only share ratings get separate records.
- All writes use `valueInputOption=RAW`, and columns are formatted as text. Leading zeros and commas survive, including when someone types directly in the Sheet.
- Saves are upserts, so retrying is safe. A SKU that is already linked to a different part is refused.

**Search** (`src/shared/query.ts`)
- Free text matches SKUs, MPN, description, category, spec values and drawers.
- Constraints are parsed from the query: `100 nF`/`0.1 µF`, `at least 25 V`/`>=25V`/bare `25 V`, `±10% or tighter`, `±0.1 pF`.
- A part with an unknown value never satisfies a constraint.

**Stock** (added last)
- Stock lives in the `Stock Ledger` tab: one row per change, with member, time, drawer, signed quantity and request id.
- Duplicate request ids return the first result.
- Removals run one at a time and are refused if they would take a drawer below zero.
- Scanning and catalog lookup never write ledger rows. **Save part only** leaves stock unchanged. **Save and add stock** saves first and then writes the explicitly confirmed count to the existing ledger. For existing parts, **Add stock** only writes the ledger operation.

**Mechanical hardware and McMaster-Carr** (`src/shared/hardware.ts`, `src/shared/mcmaster.ts`, `Inventory.saveHardware`)
- **Add hardware** on the Scan screen: part name and category are required (screw, bolt, nut, washer, pin, manifold, other). Supplier, supplier part number, product link, specs and drawer are optional.
- Each category offers its usual specs. Screws, bolts and nuts have a Metric / Imperial choice: metric sizes are `M3` with a pitch in mm, imperial sizes are `#4` or `1/4"` with threads per inch. A size from the other system is refused, so the two never mix.
- Loose hardware with no part number gets a stable inventory ID such as `HW-3F9A0C12` (from the save's request id, so a retry is harmless). While a member types a name or part number, matching hardware already in inventory is offered with **Use this part**, so they add stock there instead of creating a duplicate.
- **McMaster labels** go through the same upload, OCR and review flow. The parser reads the number after "Part Number", keeps the purchase order and line number out of it, and suggests a category and specs from the description. If the first OCR pass cannot read the part number, six more passes run at other sizes and contrast, and each part of the number is voted on. A number is filled in only when reads agree; otherwise it is offered as a one-tap guess. The label's ordered and shipped quantities are shown, and the member types the real count.
- There is no McMaster catalog lookup yet; everything comes from the label or the member. Specs are saved as `manual`, with the label or member as the source, and are not marked verified.
- Search understands `M3 x 8 mm`, `M3x8`, `M3-0.5 x 12mm`, `#4-40 x 1/2"`, `1/4-20 x 3/4`, and bare sizes like `8 mm` or `5/16"`. `M3 x 8 mm` does not match an M3 × 12 mm screw, and `M6` does not match a 1/4" screw.

**Drawers are optional**
- A blank or whitespace drawer means the part's single **Not specified** location. That text is what the `Locations` and `Stock Ledger` tabs show. Saving again without a drawer reuses it, and stock can be added and removed there like any drawer. Search "not specified" to list those parts.
- The `Parts` tab has a new last column, `name`. Existing Sheets keep their data; a server start or `npm run sheets:init` writes the new header.

## Live APIs vs demo data in this delivery

No Mouser, DigiKey or Google credentials were available while this was built, so **every check below used demo data**. Run `npm run demo:e2e` after filling in `.env` to repeat them live. Each step reports whether it was live or demo.

| Check | Status | Live or demo |
|---|---|---|
| Mouser label, original photo (`test/photos/mouser-74lvc244.jpg`) in the real scan flow | Passes. SKU, MPN and QTY come from barcodes verified by position, manufacturer from text. OCR alone garbles both part numbers on this photo. | Real photo |
| DigiKey label in the photo you sent (`test/photos/digikey-495-75588.png`, only 387×516 px) | Shows "Couldn't read the part number". The SKU can be typed and then matches TDK B32529C0564J000. The photo is too small for OCR or the 2D code. | Real photo |
| DigiKey table row: WM20054-ND / Molex / 0387236506 / qty 2 | Passes. Leading zero kept through parse, save and search. | Demo record. No specs were confirmed, so they show *unknown*. |
| Catalog lookup and specs for all of the above | Passes | **Demo** records in `fixtures.ts`, shaped like the real API responses |
| Save both bags to different drawers, then find them from a second signed-in session | Passes | In-memory or local demo sheet, **not Google Sheets** |
| Manual entry of a capacitor (80-C0805C104J5R), then the 25 V / ±10% search | Passes. 50 V ±5% qualifies. 16 V, ±20%, −20/+80% and unknown tolerance are excluded. | Demo records. The Murata/KEMET Mouser SKUs were typed from memory and should be checked live. |
| Phone UI (sign-in, manual entry, save, search) | Checked in a 375 px mobile browser | Demo |
| Google Sheets, Mouser and DigiKey clients | Written to the published APIs, **not yet run against them** | Needs credentials |

### Photo check
Test photos go in `test/photos/`. They show PO and invoice numbers, so they are **not shipped with the project** and the server only serves that folder when `SERVE_TEST_PHOTOS=1` is set (local testing only; keep it out of any deployment). Put your own bag photos there to repeat the check:
1. Start the server and open it on a phone (or a phone-sized browser).
2. Tap **Upload photo** and pick a photo.
3. Compare the fields with the table above. "Raw OCR text and barcodes" shows exactly what the parser received.

`test/photo-scan.test.ts` replays the OCR text and barcode positions recorded from the Mouser photo, so the fix is covered by `npm test`.

Expected results on the sample photos (Chromium at 375 px and 768 px, no built-in barcode reader, which is the same path iPhone Safari takes):

| Photo | SKU | MPN | QTY | Manufacturer | Message |
|---|---|---|---|---|---|
| Mouser 74LVC244 | 771-74LVC244APW-T (barcode) | 74LVC244APW,118 (barcode) | 12 (barcode) | Nexperia (text) | none |
| DigiKey 495-75588-ND (387×516 px) | blank | blank | blank | blank | Couldn't read the part number |

Real iPhones and Android phones have **not** been tested yet.

## Known limits
- **One server instance per Sheet.** Concurrency safety comes from an in-process lock. If two servers write to the same Sheet, the stock checks can race.
- Every search reads all tabs. That is fine for a few thousand rows. Add caching if the Sheet grows much larger.
- DigiKey v4 `productdetails` and Mouser Search request and response shapes are coded from their public docs. Confirm them with the first live run of `npm run demo:e2e`.
- Reading barcodes plus OCR takes about 3–5 s per photo on a laptop. Expect longer on older phones.
- In the Mouser demo record the 74LVC244's pin count is *unknown* because Mouser does not list it. A live DigiKey lookup with an exact MPN match fills it in.
