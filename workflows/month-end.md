# Month-End Close Checklist

Run the month-end close checklist, compute financial statements, and flag issues.

**Input:** Month in YYYY-MM format (e.g. `2026-02`).

User-facing phases:
1. Identify close blockers.
2. Check missing documents and duplicate invoices.
3. Compute statements.
4. Show READY TO CLOSE or HAS BLOCKERS with concrete inline next actions.

Reporting is only accurate after the relevant journals, invoices, and transactions are confirmed: the unconfirmed (PROJECT) records surfaced as blockers below are not yet in the ledger, so the computed statements do not reflect them until they are confirmed.

<!-- E_ARVELDAJA_FEATURE_START:standard -->
If the user says they recently changed data in the e-arveldaja web UI or asks for fresh numbers, call `clear_cache` once before Step 1 (or pass `fresh: true` to each report tool below).
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Reports read through a short-lived cache (a few minutes): if the user just changed data in the e-arveldaja web UI, say the figures may lag those edits briefly.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

## Step 1: Run the checklist

<!-- E_ARVELDAJA_FEATURE_START:standard -->
Call `month_end_close_checklist` with `month`: the YYYY-MM value.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Call `run_accounting_report` with `report`: `month_end` and `month`: the YYYY-MM value.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

## Step 2: Flag blocking issues

Present in priority order:

**BLOCKERS (must fix before closing):**
1. Unconfirmed purchase invoices — not registered in the ledger
2. Unconfirmed journal entries — adjustments not posted
3. Unconfirmed bank transactions — cash not reconciled

For blockers, show ID, date, amount/title, then offer concrete inline actions. If there are many blockers of the same low-risk type, show the first 10 plus counts and ask for one batch approval with exceptions instead of one yes/no question per item. Do NOT close the workflow with "go fix these in the e-arveldaja UI". That is a last-resort fallback only when no MCP tool can perform the action and the API has already rejected the inline attempt.

Inline actions per blocker type:
<!-- E_ARVELDAJA_FEATURE_START:standard -->
- Purchase invoices: offer `confirm_purchase_invoice`, or `delete_purchase_invoice` if the user confirms it is a duplicate
- Journals: offer `confirm_journal`
- Transactions: prefer the **Reconcile Bank** workflow for unmatched rows; for already-matched single rows offer `confirm_transaction` directly
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
- Transactions: run the **Reconcile Bank** workflow (`reconcile_bank_transactions`), and the **Classify Unmatched** workflow for rows with no invoice match
- Purchase-invoice and journal drafts: this profile cannot confirm or delete an existing draft outside the document flow that created it. List them with their IDs and tell the user that the `standard` or `full` profile (`EARVELDAJA_PROFILE`) confirms them inline; the web UI is the fallback.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

**WARNINGS (review but may not block close):**
- Overdue payables — check if payment was made but not yet recorded
- If the month is still open, overdue is evaluated as of today (`overdue_as_of`); report `due_before_month_end_*` as invoices still payable this month, not as overdue.

<!-- E_ARVELDAJA_FEATURE_START:sales -->
**Sales-side extension:**
- Treat **Unconfirmed sale invoices** as blockers because revenue is not recorded.
- Show each sale-invoice ID, date, and amount, and offer `confirm_sale_invoice` as the inline action.
- Report **Overdue receivables** as a warning that may need follow-up or a doubtful-debt provision.
<!-- E_ARVELDAJA_FEATURE_END:sales -->
<!-- E_ARVELDAJA_FEATURE_START:guided-sales -->
**Sales-side extension:**
- Treat **Unconfirmed sale invoices** as blockers because revenue is not recorded.
- Show each sale-invoice ID, date, and amount, and offer to confirm it with `manage_sale_invoice` (`action: "confirm"`: `mode: "prepare"` first, then `mode: "execute"` with the returned `plan_handle` after explicit approval).
- Report **Overdue receivables** as a warning that may need follow-up or a doubtful-debt provision.
<!-- E_ARVELDAJA_FEATURE_END:guided-sales -->

## Step 3: Check for missing documents

<!-- E_ARVELDAJA_FEATURE_START:standard -->
Call `find_missing_documents` with `date_from`: YYYY-MM-01 and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Call `run_accounting_report` with report="missing_documents", `date_from`: YYYY-MM-01 and `date_to`: the last day of the month.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

Report every confirmed record without an attached source document — purchase invoices, manual journals, and directly booked bank transactions alike (RPS requires a source document on every entry).

<!-- E_ARVELDAJA_FEATURE_START:standard -->
## Step 4: Check for duplicate invoices

Call `detect_duplicate_purchase_invoice`:
- `date_from`: YYYY-MM-01
- `date_to`: last day of the month

Report exact duplicates (same supplier + invoice number) and suspicious matches (same supplier + amount + date with different numbers).
<!-- E_ARVELDAJA_FEATURE_END:standard -->

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
Warnings:        X items
Missing docs:    X records
Duplicates:      X found (or "not checked" when Step 4 did not run)

Trial Balance:   BALANCED / IMBALANCED by X EUR
Balance Sheet:   BALANCED / IMBALANCED
YTD Net Profit:  X.XX EUR

Status: READY TO CLOSE / HAS BLOCKERS
```

If blockers exist, list specific actions needed. Offer to help fix them.
