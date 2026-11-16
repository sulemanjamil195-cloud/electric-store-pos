# Electric Store POS & Inventory (offline desktop)

An offline-first desktop shop-management application built from the supplied **Electric Store POS and Inventory System – Software Requirements Specification v1.0**. Its interface is React + TypeScript; its desktop process is Electron; its permanent data is SQLite (`better-sqlite3`). Currency values are stored as whole **paisa**. It does **not** need a server, subscription, internet account or cloud service after installation.

> **Release status: functional development build / pilot, not a completed or production-certified implementation of all 35 SRS pages.** Core end-to-end flows have automated database tests. The actual Electron UI, printers and native installer have **not** been executed here because this environment cannot download npm dependencies. Do a local run and shop acceptance testing before using for live finances.

## 1. Run on your computer

**Requirements**: Windows 10/11 recommended (macOS or Linux can run development builds), Node.js **22 LTS**, npm, 4 GB RAM minimum, recommended 8 GB. Internet is needed for the **first dependency installation** only; the finished app runs fully offline.

1. Extract this ZIP anywhere, e.g. `C:\Projects\electric-store-pos`.
2. Open that directory in VS Code or a terminal.
3. Check Node and npm:

   ```bash
   node -v
   npm -v
   ```

4. Install app dependencies (first time only):

   ```bash
   npm install
   ```

   The `postinstall` script rebuilds the native SQLite module for your Electron version. If it fails on Windows, install **Visual Studio Build Tools C++** and retry `npm install`. Network access and a working Node installation are required for this step.

5. Start the desktop app:

   ```bash
   npm run dev
   ```

6. On first run, enter your shop name and create the **owner** username and password. **Write the recovery key down and keep it outside the shop computer**.
7. Add a test product under **Products** with an opening quantity; then use **POS Counter** to make a test sale.

The SQLite database and backups are stored in **Electron's local user-data directory**, separate from the application installation. Reinstalling the app does not normally delete the user-data folder. Do not manually alter database files while Electron is open.

### Build the Windows installer

On a **Windows computer**, after installing dependencies:

```bash
npm run build:win
```

Look in the `release/` folder for the NSIS installer (EXE). The installer is not supplied in this ZIP because the Windows packaging environment and dependency downloads were unavailable here. **Do not copy the development source as if it were the installer.**

Mac development: run `npm install` then `npm run dev` in Terminal. To build an installer for Windows, use Windows or a configured cross-build environment.

### Test the database/business rules

```bash
npm test
```

These tests cover owner login/recovery, products/stock/FTS-fuzzy search, weighted average cost, purchasing/payables, split-payment sales, bill retry idempotency, customer credit limits, returns, historical costs, cash reconciliations, access restrictions and SQLite consistency. The included tests use `node:sqlite` as a fallback if `better-sqlite3` is not installed; the packaged app prefers `better-sqlite3`.

## 2. How to use the shop workflows

- **Products**: create/edit/archive/restore items, prices, barcode, SKU, category, alias and opening stock. Import/export CSV and `.xlsx`; preview imports before saving. CSV/XLSX prices are in **rupees**, converted to integer paisa in SQLite. Reimporting an exported sheet with `id` updates existing products rather than duplicating inventory quantities.
- **POS Counter**: search by name/typos/barcode; add items; change quantity; line and bill discounts; select customer; record cash/bank/wallet/card/udhaar and split payments; **Complete Sale**. The sale, payments, stock movements, customer ledger and audit record commit in **one atomic SQLite transaction**. Keyboard: **F2** search, **F4** hold, **F10** complete. Barcode scanner keyboard-wedge input works through the search field.
- **Held bills**: current bill auto-saves; F4 saves a held bill. Resume held bills after a restart. Bill IDs provide retry-idempotency.
- **Sales & Returns**: open bill, print/reprint receipts, save A4 invoice PDF, return selected quantities to stock or scrap and refund cash or credit.
- **Inventory**: enter actual counted quantity with reason; check low stock and the stock movement ledger.
- **Purchases**: receive stock from a supplier, record supplier outstanding balance, and calculate weighted-average product costs. Supplier payments can settle older purchases.
- **Customers & Udhaar**: create customers, optional credit limit, receive full/partial repayments and view a customer ledger.
- **Expenses / Cash Register**: record expenses, open and close a cash session, record cash movements and compare counted versus expected cash. Cash purchases and cash supplier repayments are included in expected drawer balance.
- **Profit & Reports**: select inclusive dates (shop timezone: **Asia/Karachi**), see net revenue, COGS, gross/net profit, expenses and group breakdowns; export CSV, XLSX or PDF.
- **Warranty Desk**: attach serial number and warranty months to a sale item, search by serial/bill/phone and record a claim.
- **Staff & Audit**: create owner/manager/cashier users; login required; main-process role checks protect sensitive cost and profit data. Audit records are append-only from the interface.
- **Backup & Settings**: creates verified SQLite online backups every 15 minutes, on demand and on normal exit; select a USB/external backup folder in Settings, run consistency checks, restore a backup. Shop name, phone, address, receipt footer and 58/80-mm receipt width are configurable. Receipt printing uses the operating system's print dialog.

## 3. Critical precautions before using in a real shop

1. **Run alongside your existing billing method first**, with test data, and reconcile the cash drawer, inventory quantities, sales totals and monthly profit manually.
2. **Test receipt printer and scanner on the actual Windows machine**. Printer driver, page size, cutting, duplicate labels and offline operation require real hardware tests.
3. Select an external **backup folder on a different physical drive**; don't rely only on same-disk backups. Unplug the USB and test restoration of a recent backup on a spare machine. Automatic external backup copy failures must also be checked manually.
4. Use a **UPS** and verify power-loss recovery under realistic conditions. An SQLite transaction gives atomicity, but the SRS's 100 sudden-power-cut acceptance test has **not** been performed.
5. Don't enter real customer data or rely on reported profit for tax/accounting until independent validation has been completed.
6. Create at least one **owner** and one **cashier** test account. Confirm that cashier cannot view cost/profit or modify sensitive settings.
7. Keep the recovery key in a locked place. Do not share it in screenshots, public repositories or logs.

## 4. Known gaps against the SRS (important)

This project has working core workflows but is **not yet SRS-complete**. Outstanding items include:

- Product photos and image thumbnails, advanced variants/bundles, barcode-label printing.
- Trigram/worker-based search benchmarking at 100,000 products and typo-match acceptance metrics; current fallback fuzzy search scans a limited recent candidate set.
- Price/discount **percent modes** and fully owner-configurable role permission and discount matrices; current cashier discount is fixed at up to 10% of the line/bill; refunds require manager/owner in this build.
- Formal purchase-return workflow; quotation/invoice conversion; paid-installation charges and configurable per-product GST/tax rules.
- Full report drill-down to individual bills for every metric, sales-returns allocations across every breakdown, long-period pre-aggregated summaries, all report varieties and day book.
- Full backup retention policy (24 hourly/30 daily/12 monthly), pre-restore record-count comparisons, robust missing-drive alerts, encrypted database/backups, migration rollback and watchdog crash recovery.
- Physical-printer certification, silent ESC/POS commands, cash-drawer kick, custom receipt layout designer, serial warranty slips and all NFR performance targets.
- Full test-suite goals (80% business-logic coverage, all hardware E2E tests, 100 power-cut tests) and formal Windows installer acceptance.

See `docs/TEST_PLAN.md` for the acceptance steps. The supplied SRS itself is the authoritative requirements list.

## 5. Architecture and security

- `electron/main.cjs`: desktop window, main-process IPC, printer, backup/restore and file exports.
- `electron/service.cjs`: validation, atomic business rules, role checks, accounting and audit.
- `electron/db.cjs`: WAL SQLite schema and database connection.
- `electron/preload.cjs`: restricted `contextBridge` API to the React UI.
- `src/main.tsx`, `src/style.css`: responsive desktop UI.
- `tests/flows.test.cjs`: automated business-rule checks.

Security basics: `nodeIntegration: false`, `contextIsolation: true`, sandboxed renderer, no remote content, parameterized SQL, hashed credentials (bcryptjs), role enforcement in the main process, store costs hidden from cashiers. This is a good starting foundation; a production software-security audit is still necessary.

## 6. What I need from you when you test locally

Send the **exact terminal error and a screenshot** if `npm install`, `npm run dev` or `npm run build:win` fails. Include: Windows/macOS version, output of `node -v`, receipt printer model and 58/80mm paper width, and whether you have a USB barcode scanner. Do **not** send passwords, recovery keys, customer personal data or the live SQLite database.
