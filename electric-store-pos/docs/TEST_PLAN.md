# Shop acceptance checklist (run locally on the real shop PC)

The SRS acceptance criteria require power-loss, search, profit, security and performance testing. Database-only tests are included; printer/installer/UI/hardware checks below still require local work.

## Environment

- [ ] Windows 10/11 clean install launches with no Node.js installed on the destination PC.
- [ ] Run with Wi-Fi/Ethernet disconnected. Make a sale, search products, back up and print.
- [ ] Thermal 58/80-mm printer prints a new bill and a correctly labeled duplicate copy.
- [ ] Scanner scans a real barcode through the POS search box and adds the correct item.
- [ ] Printer disconnected during a completed sale leaves the sale saved and reprintable.

## Accounting

- [ ] Verify line discount, bill discount and total to the paisa.
- [ ] Check split cash/bank/credit allocation and change returned.
- [ ] Verify 0-stock item cannot be sold accidentally; stock ledger reconciles after each sale.
- [ ] Make purchase at new cost and verify weighted-average cost by hand.
- [ ] Return partial quantity and check refund plus COGS reversal against the original bill.
- [ ] Make credit sale, receive partial payment, verify credit limit and customer balance.
- [ ] Verify cash opening, expenses, supplier cash payments and closing difference.
- [ ] Reconcile at least one month's profit with a manually prepared spreadsheet.

## Crash, backup and recovery

- [ ] Back up to a **different drive**; verify the copy exists and SQLite integrity is OK.
- [ ] Restore a verified test backup and compare bill/customer/product counts and balances.
- [ ] Repeat sudden-power-off simulation during bill saving **100 times** on a disposable test PC/database. No half-saved bill, orphan line or stock discrepancy is acceptable.
- [ ] Repeat sudden-power-off while printing and backing up.
- [ ] Confirm drafts survive sudden interruption and the last committed sale remains intact.

## Security

- [ ] Cashier cannot access cost, margin, profit, exports with cost data or owner IPC actions.
- [ ] Manager refund permission and any expected owner approval flow follow shop policy.
- [ ] Invalid PIN/login, password recovery, user disablement and audit log reviewed.

## Performance

- [ ] Test a seeded **100,000-product** database, **1,000,000 sale items**, **50,000 customers**.
- [ ] POS search latency p95 under 100ms, add item under 50ms, save+print under 1s on target computer.
- [ ] Yearly reports under 3s and five-year report under 10s; profit target under 1s / 3s.

These tests have **not** all passed yet. Do not treat this checklist as evidence of certification.
