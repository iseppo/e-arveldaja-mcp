# Month-End Close Checklist

Run the month-end close checklist, compute financial statements, and flag issues.

**Input:** Month in YYYY-MM format (e.g. `2026-02`).

User-facing phases:
1. Identify close blockers and duplicate invoices.
2. Check missing documents.
3. Compute statements.
4. Show READY TO CLOSE or HAS BLOCKERS with concrete inline next actions.

Reporting is only accurate after the relevant journals, invoices, and transactions are confirmed: the unconfirmed (PROJECT) records surfaced as blockers below are not yet in the ledger, so the computed statements do not reflect them until they are confirmed.

e-arveldaja itself books the VAT return (KMD) settlement with the tax authority and the prepayment-account (1516) entries. Do not compute, propose, or book those entries here.

<!-- E_ARVELDAJA_FEATURE_START:standard -->
If the user says they recently changed data in the e-arveldaja web UI or asks for fresh numbers, call `clear_cache` once before Step 1.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Reports read through a short-lived cache (a few minutes): if the user just changed data in the e-arveldaja web UI, say the figures may lag those edits briefly.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

## Step 1: Run the checklist

<!-- E_ARVELDAJA_FEATURE_START:standard -->
Call `month_end_close_checklist` with `month`: the YYYY-MM value. Overdue and due-before-month-end lists show at most 10 rows (`truncated`); report their `count` and `total`.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Call `run_accounting_report` with `report`: `month_end` and `month`: the YYYY-MM value. Compact output cuts long lists (`truncated`): report the `count` values, and call again with `detail: "full"` when you need every row.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

<!-- E_ARVELDAJA_FEATURE_START:standard -->
## Step 2: Check for duplicate invoices

Run this before offering any purchase-invoice action. Call `detect_duplicate_purchase_invoice`:
- `date_from`: the first day of the PREVIOUS month (catches re-bookings across the month boundary)
- `date_to`: last day of the month

Report `exact_duplicates` (same supplier + invoice number) and `suspicious_same_amount_date` (same supplier + amount + date with different numbers).
<!-- E_ARVELDAJA_FEATURE_END:standard -->

## Step 3: Flag blocking issues

Present in priority order:

**BLOCKERS (must fix before closing):**
1. Unconfirmed purchase invoices — not registered in the ledger
2. Unconfirmed journal entries — adjustments not posted
3. Unconfirmed bank transactions — cash not reconciled
4. Unconfirmed sale invoices, whenever returned — revenue not recorded

Report ALL returned blocker lists, including `unconfirmed_sale_invoices`, regardless of which confirmation actions this profile exposes. Determine sales coverage by the PRESENCE of `unconfirmed_sale_invoices`, even when its count is zero; absence means a purchase-side check only. A returned `ready_to_close: false` always means HAS BLOCKERS. Never convert it to READY because a blocker lacks an available action. Show overdue receivables as a warning whenever returned.

For blockers, show ID, date, amount/title, then offer concrete inline actions. Never batch-approve purchase invoices or journals: confirm them one at a time. For many bank-transaction rows, show the first 10 plus counts and use the reconcile workflow's own batch review. Do NOT close the workflow with "go fix these in the e-arveldaja UI". That is a last-resort fallback only when no MCP tool can perform the action and the API has already rejected the inline attempt.

Journals numbered `DIV-…` (dividend) or `YEC-…` (year-end close): do not confirm them here. They belong to the dividend or year-end close workflow and need its prerequisites (an approved annual report and a distribution decision for dividends). Name them and point the user there.

Inline actions per blocker type:
<!-- E_ARVELDAJA_FEATURE_START:standard -->
- Purchase invoices: a draft listed in `exact_duplicates` / `suspicious_same_amount_date`, or one a document workflow left held, is NOT confirmed here — route it back to the **Book Invoice** workflow (or offer `delete_purchase_invoice` if the user confirms it is a duplicate). For any other draft, show supplier, invoice number, net/VAT/gross, whether a source document is attached (`get_purchase_invoice`) and the Step 2 result, then offer `confirm_purchase_invoice` for that one invoice.
- Journals: call `get_journal`, show its number and postings (account, debit/credit, amount), then offer `confirm_journal` for that one journal.
- Transactions: prefer the **Reconcile Bank** workflow for unmatched rows. A row whose distribution goes to another own bank account is an inter-account transfer: use `reconcile_inter_account_transfers`, never `confirm_transaction`. For other single rows with a known distribution, offer `confirm_transaction` with `block_on_duplicate: true`.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
- Transactions: run the **Reconcile Bank** workflow (`reconcile_bank_transactions`), and the **Classify Unmatched** workflow for rows with no invoice match
- Purchase-invoice and journal drafts: this profile cannot confirm or delete an existing draft outside the document flow that created it. List them with their IDs and tell the user that the `standard` or `full` profile (`EARVELDAJA_PROFILE`) confirms them inline; the web UI is the fallback.
- If sales blockers are returned and no sales confirmation action is available, still show their IDs, dates and amounts; suggest a new review on `guided-sales`, `standard` or `full`.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

**WARNINGS (review but may not block close):**
- Overdue payables — check if payment was made but not yet recorded
- If the month is still open, overdue is evaluated as of today (`overdue_as_of`); report `due_before_month_end_*` as invoices still payable this month, not as overdue.

<!-- E_ARVELDAJA_FEATURE_START:sales -->
**Sales-side extension:**
- Show each sale-invoice ID, date, and amount, and offer `confirm_sale_invoice` as the inline action.
<!-- E_ARVELDAJA_FEATURE_END:sales -->
<!-- E_ARVELDAJA_FEATURE_START:guided-sales -->
**Sales-side extension:**
- Show each sale-invoice ID, date, and amount, and offer to confirm it with `manage_sale_invoice` (`action: "confirm"`: `mode: "prepare"` first, then `mode: "execute"` with the returned `plan_handle` after explicit approval).
<!-- E_ARVELDAJA_FEATURE_END:guided-sales -->

## Step 4: Check for missing documents

<!-- E_ARVELDAJA_FEATURE_START:standard -->
Call `find_missing_documents` with `date_from`: YYYY-MM-01 and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Call `run_accounting_report` with report="missing_documents", `date_from`: YYYY-MM-01 and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

Report the per-section counts of confirmed records without an attached source document — purchase invoices, manual journals, and directly booked bank transactions alike (RPS requires a source document on every entry); list the returned rows, and call again with `detail: "full"` when a section is `truncated`.

## Step 5: Compute financial statements

<!-- E_ARVELDAJA_FEATURE_START:standard -->
Call `compute_trial_balance` with `date_from`: YYYY-MM-01 and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Call `run_accounting_report` with report="trial_balance", `date_from`: YYYY-MM-01 and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

Verify total debits = total credits. Treat sub-cent rounding deltas (under 0.01 EUR) as acceptable in multi-currency books; anything larger is a blocker that needs investigation.

<!-- E_ARVELDAJA_FEATURE_START:standard -->
Call `compute_profit_and_loss` with `date_from`: YYYY-01-01 and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Call `run_accounting_report` with report="profit_and_loss", `date_from`: YYYY-01-01 and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

Use the fiscal-year start as `date_from` (YYYY-01-01 for a calendar fiscal year). Show YTD P&L: total revenue, total expenses, net profit.

<!-- E_ARVELDAJA_FEATURE_START:standard -->
Call `compute_balance_sheet` with `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Call `run_accounting_report` with report="balance_sheet" and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

Verify balanced (assets = liabilities + equity).

## Step 6: Summary report

```
Month-End Close: YYYY-MM
================================
Blockers:        X issues
Coverage:        Purchase-side only / Purchases and sales read
Warnings:        X items
Missing docs:    X records
Duplicates:      X found (or "not checked" when Step 2 did not run)

Trial Balance:   BALANCED / IMBALANCED by X EUR
Balance Sheet:   BALANCED / IMBALANCED
YTD Net Profit:  X.XX EUR

Status: READY TO CLOSE (within the checked coverage) / HAS BLOCKERS
```

Status is HAS BLOCKERS when `ready_to_close` is false, OR the trial balance or balance sheet is off by more than 0.01 EUR, OR exact duplicates were found — even if the tool reported `ready_to_close: true`. Missing documents, suspicious duplicate matches and overdue items are WARNINGS.

If blockers exist, list specific actions needed. Offer to help fix them.
<!-- E_ARVELDAJA_FEATURE_START:year-end -->

For December (the last month of a calendar fiscal year), offer the year-end close next: `prepare_year_end_close` with `year` (RIK method; dry run).
<!-- E_ARVELDAJA_FEATURE_END:year-end -->
