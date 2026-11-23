// Creates the Parts / Supplier SKUs / Specs / Locations / Stock Ledger tabs in the Google Sheet named by
// GOOGLE_SHEET_ID, writes header rows, and formats every column as plain text. Safe to run again.
//   npm run sheets:init

import { SheetsStore, loadServiceAccount } from '../src/server/store/sheets-store.ts';

const sa = loadServiceAccount();
if (!sa || !process.env.GOOGLE_SHEET_ID) {
  console.error('Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE (or GOOGLE_SERVICE_ACCOUNT_JSON) in .env first. See README.');
  process.exit(1);
}
const store = new SheetsStore(sa, process.env.GOOGLE_SHEET_ID);
await store.ensureTabs();
console.log(`Tabs ready in https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID} (shared with ${sa.client_email}).`);
